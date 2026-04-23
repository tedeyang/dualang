#!/usr/bin/env node
/**
 * 熔断状态机端到端：不触发真 429（不可控），直接操纵 storage 模拟。
 *   1) 给 SF primary 打 COOLING + cooldownUntil 未来 → 翻译应自动跳到 Moonshot
 *   2) 把 cooldownUntil 改成过去 → 下次选路径走懒惰 unfreeze → 存储里 state 变 PROBING
 *   3) 最后清理掉测试写入，避免污染真实使用
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const playwright = require(join(__dirname, '../e2e/node_modules/playwright'));
const { chromium } = playwright;

const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctxs = browser.contexts();

async function findExtId() {
  for (const ctx of ctxs) for (const w of ctx.serviceWorkers()) {
    if (w.url().includes('background.js')) return new URL(w.url()).host;
  }
  for (const ctx of ctxs) for (const p of ctx.pages()) {
    if (p.url().startsWith('chrome-extension://')) return new URL(p.url()).host;
  }
  return null;
}
const extId = await findExtId();
if (!extId) { console.log('❌ 没找到扩展'); process.exit(2); }
console.log(`[ext] ${extId}`);

// 先 reload SW 吃最新 bundle（SW 没起就开 popup 唤醒后再 reload）
async function getSw() {
  for (const c of browser.contexts()) for (const w of c.serviceWorkers()) {
    if (w.url().includes('background.js')) return w;
  }
  return null;
}
let sw = await getSw();
if (!sw) {
  const waker = await ctxs[0].newPage();
  await waker.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });
  await waker.waitForTimeout(800);
  sw = await getSw();
  await waker.close();
}
if (sw) {
  try { await sw.evaluate(() => chrome.runtime.reload()); } catch (_) {}
  await new Promise((r) => setTimeout(r, 2500));
}

const ctx = ctxs[0];
const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

// ==== 0) 切到 failover 模式 + 设 SF 为 primary / Moonshot 为 secondary（便于观察切换）====
await page.evaluate(() => chrome.storage.sync.set({
  dualang_routing_v1: {
    mode: 'failover', preference: 0.5, concurrency: 1,
    primaryId: 'sf:THUDM/GLM-4-9B-0414',
    secondaryId: 'moonshot:moonshot-v1-8k',
  },
}));
console.log('[setup] routing=failover, primary=SF, secondary=Moonshot');

// ==== 1) 手写一条 COOLING 给 SF primary ====
const COOL_ID = 'sf:THUDM/GLM-4-9B-0414';
const originalCircuit = await page.evaluate((id) => chrome.storage.local.get('dualang_circuit_v1').then((o) => o.dualang_circuit_v1?.[id]), COOL_ID);
console.log('[pre] 原 circuit:', originalCircuit || 'none');

const FUTURE = Date.now() + 60_000;
await page.evaluate(({ id, until }) => {
  return chrome.storage.local.get('dualang_circuit_v1').then(async (o) => {
    const map = o.dualang_circuit_v1 || {};
    map[id] = {
      state: 'COOLING', cooldownUntil: until, cooldownMs: 60_000,
      probeWeight: 1, probeSuccessStreak: 0, lastTransitionAt: Date.now(),
    };
    await chrome.storage.local.set({ dualang_circuit_v1: map });
  });
}, { id: COOL_ID, until: FUTURE });
console.log(`[inject] SF 置 COOLING 直到 ${new Date(FUTURE).toLocaleTimeString()}`);

// ==== 触发翻译 → 应跳过 SF 走 Moonshot ====
const resp1 = await page.evaluate(() => chrome.runtime.sendMessage({
  action: 'translate',
  payload: { texts: ['Hello world, testing circuit'], priority: 2, skipCache: true },
}));
console.log(`[translate#1] success=${resp1?.success} model=${resp1?.data?.model}`);
if (resp1?.data?.model?.includes('moonshot')) {
  console.log('  ✓ primary COOLING 被跳过，走 secondary');
} else {
  console.log('  ❌ 期望 moonshot，实际用了', resp1?.data?.model);
}

// ==== 2) 把 cooldownUntil 改成过去 → 下次 selectCandidates 懒惰 unfreeze 转 PROBING ====
const PAST = Date.now() - 1000;
await page.evaluate(({ id, until }) => {
  return chrome.storage.local.get('dualang_circuit_v1').then(async (o) => {
    const map = o.dualang_circuit_v1 || {};
    map[id].cooldownUntil = until;
    await chrome.storage.local.set({ dualang_circuit_v1: map });
  });
}, { id: COOL_ID, until: PAST });
console.log(`[inject] cooldownUntil 改成过去，期待下次选路 auto unfreeze → PROBING`);

const resp2 = await page.evaluate(() => chrome.runtime.sendMessage({
  action: 'translate',
  payload: { texts: ['Second test round'], priority: 2, skipCache: true },
}));
console.log(`[translate#2] success=${resp2?.success} model=${resp2?.data?.model}`);

await page.waitForTimeout(500);
const afterCircuit = await page.evaluate((id) => chrome.storage.local.get('dualang_circuit_v1').then((o) => o.dualang_circuit_v1?.[id]), COOL_ID);
console.log('[post] SF circuit 状态:', afterCircuit?.state, `probeWeight=${afterCircuit?.probeWeight}`, `streak=${afterCircuit?.probeSuccessStreak}`);

// ==== 结果判定 ====
console.log('\n============ 判定 ============');
if (afterCircuit?.state === 'HEALTHY' || afterCircuit?.state === 'PROBING') {
  console.log(`✅ 自恢复路径生效：COOLING → ${afterCircuit.state}`);
} else {
  console.log(`❌ 没恢复，仍为 ${afterCircuit?.state}`);
}

// ==== 3) 清理：把 circuit 复位（防止干扰后续真实使用）====
await page.evaluate((id) => {
  return chrome.storage.local.get('dualang_circuit_v1').then(async (o) => {
    const map = o.dualang_circuit_v1 || {};
    delete map[id];
    await chrome.storage.local.set({ dualang_circuit_v1: map });
  });
}, COOL_ID);
console.log('[cleanup] SF circuit 已删除（复位为 HEALTHY 默认）');

await browser.close();
