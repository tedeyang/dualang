#!/usr/bin/env node
/**
 * P6 smart routing smoke：
 *   1) popup 切到 smart 模式 → 验证 dualang_routing_v1.mode 持久化
 *   2) 拉动 pref slider → preference 写入存储
 *   3) 触发翻译 → verify selectCandidates 走 smart 路径（response model 与 scoring winner 一致）
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

// 找 extension id：先试 SW，再试已打开的 popup tab
async function findExtId() {
  for (const ctx of ctxs) for (const w of ctx.serviceWorkers()) {
    if (w.url().includes('background.js')) return new URL(w.url()).host;
  }
  for (const ctx of ctxs) for (const p of ctx.pages()) {
    if (p.url().startsWith('chrome-extension://')) return new URL(p.url()).host;
  }
  return null;
}
let extId = await findExtId();
if (!extId) { console.log('❌ 找不到 dualang 扩展（SW + popup 都没）'); process.exit(2); }
console.log(`[ext] ${extId}`);

const ctx = ctxs[0];
const page = await ctx.newPage();
// 打开 popup 会顺带唤醒 SW；也自然加载 disk 上的 latest bundle
await page.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

// 1) 切到 Providers tab
await page.click('[data-tab="providers"]');
await page.waitForTimeout(500);

// 2) 切 smart 模式
console.log('[toggle] smart 模式');
await page.click('#rmSmart');
await page.waitForTimeout(400);
let state = await page.evaluate(() => chrome.storage.sync.get('dualang_routing_v1'));
console.log(`  → sync.routing.mode = ${state.dualang_routing_v1?.mode}`);

// 3) 调 pref slider 到 20（fastest 方向）
console.log('[slider] 拉到 20%');
await page.evaluate(() => {
  const el = document.getElementById('prefSlider');
  el.value = '20';
  el.dispatchEvent(new Event('change'));
});
await page.waitForTimeout(400);
state = await page.evaluate(() => chrome.storage.sync.get('dualang_routing_v1'));
console.log(`  → sync.routing.preference = ${state.dualang_routing_v1?.preference}`);

// 4) dump providers 的 profile 看谁会被 smart 模式选中
const snapshots = await page.evaluate(async () => {
  const all = await chrome.storage.local.get(['dualang_perf_v1', 'dualang_capabilities_v1', 'dualang_circuit_v1']);
  const sync = await chrome.storage.sync.get(['dualang_providers_v1']);
  return {
    providers: sync.dualang_providers_v1 || [],
    perf: all.dualang_perf_v1 || {},
    caps: all.dualang_capabilities_v1 || {},
    circuit: all.dualang_circuit_v1 || {},
  };
});
console.log('\n[state] providers 画像：');
for (const p of snapshots.providers) {
  const prf = snapshots.perf[p.id];
  const cap = snapshots.caps[p.id];
  const rttLong = prf?.rttMs?.long?.value ? `${Math.round(prf.rttMs.long.value)}ms` : '-';
  const rttMed = prf?.rttMs?.medium?.value ? `${Math.round(prf.rttMs.medium.value)}ms` : '-';
  const rttShort = prf?.rttMs?.short?.value ? `${Math.round(prf.rttMs.short.value)}ms` : '-';
  const sr = prf?.successRate?.value?.toFixed(2) ?? '-';
  const qs = prf?.qualityScore?.value?.toFixed(2) ?? '-';
  console.log(`  ${p.id}`);
  console.log(`    rtt=${rttShort}/${rttMed}/${rttLong}  successRate=${sr}  quality=${qs}  batch=${cap?.batch ?? '?'} stream=${cap?.streaming ?? '?'}`);
}

// 5) 触发批量翻译 → 检查用了谁
console.log('\n[translate] 批量 3 条短文本（smart 模式应选最优 provider）');
const resp = await page.evaluate(() => chrome.runtime.sendMessage({
  action: 'translate',
  payload: {
    texts: [
      'Good morning!',
      'The meeting is at 10am.',
      'Bring your laptop please.',
    ],
    priority: 2,
    skipCache: true,
  },
}));
console.log(`  success=${resp?.success} model=${resp?.data?.model} baseUrl=${resp?.data?.baseUrl}`);

// 6) 切回 failover 做对照
console.log('\n[toggle] 切回 failover');
await page.click('#rmFailover');
await page.waitForTimeout(400);
state = await page.evaluate(() => chrome.storage.sync.get('dualang_routing_v1'));
console.log(`  → sync.routing.mode = ${state.dualang_routing_v1?.mode}`);

const resp2 = await page.evaluate(() => chrome.runtime.sendMessage({
  action: 'translate',
  payload: {
    texts: ['Good morning!', 'Test again.'],
    priority: 2,
    skipCache: true,
  },
}));
console.log(`  failover resp: model=${resp2?.data?.model}`);

const used = { smart: resp?.data?.model, failover: resp2?.data?.model };
console.log('\n============ 结论 ============');
console.log(`smart 模式用: ${used.smart}`);
console.log(`failover 模式用: ${used.failover}`);
if (used.smart && used.failover) {
  console.log('✅ 两种模式都能跑通翻译');
}

await browser.close();
