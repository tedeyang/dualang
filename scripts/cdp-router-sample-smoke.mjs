#!/usr/bin/env node
/**
 * Router P3 端到端实测：点"测试"按钮，走完 sampler battery，验证 capability + performance 落盘。
 *
 * 默认只跑 moonshot:moonshot-v1-8k（成本最小 + 稳定）。
 * 可通过 argv[2] 覆盖：node cdp-router-sample-smoke.mjs sf:THUDM/GLM-4-9B-0414
 *
 * 消耗估算：约 10K tokens，串行 ~60s（5 cases × ~10s + 1s × 4 gap）
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const playwright = require(join(__dirname, '../e2e/node_modules/playwright'));
const { chromium } = playwright;

const TARGET_ID = process.argv[2] || 'moonshot:moonshot-v1-8k';

const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctxs = browser.contexts();
let sw = null;
for (const ctx of ctxs) for (const w of ctx.serviceWorkers()) if (w.url().includes('background.js')) sw = w;
if (!sw) { console.log('❌ SW missing'); process.exit(2); }
const extId = new URL(sw.url()).host;
console.log(`[sw] ${extId}`);

// 挂 SW console，捕捉 [router.sample] 逐 case 的译文头 + 失败原因
sw.on('console', (c) => {
  const t = c.text();
  if (t.includes('[router.sample]')) {
    console.log('  SW ▶', t.slice(0, 300));
  }
});

const ctx = ctxs[0];
const page = await ctx.newPage();
page.on('console', (c) => {
  const t = c.text();
  if (t.includes('router') || t.includes('provider')) {
    // 不重复打印 UI 层消息，SW 够用
  }
});
await page.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });
await page.click('[data-tab="providers"]');
await page.waitForTimeout(800);

const cardSelector = `.provider-card[data-provider-id="${TARGET_ID}"]`;
const exists = await page.evaluate((s) => !!document.querySelector(s), cardSelector);
if (!exists) {
  console.log(`❌ 没找到 provider card: ${TARGET_ID}`);
  await browser.close();
  process.exit(2);
}

console.log(`[click] 测试 on ${TARGET_ID}`);
await page.click(`${cardSelector} button[data-action="test"]`);

// 轮询 sample-log
const start = Date.now();
const TIMEOUT_MS = 3 * 60 * 1000;
let lastLineCount = 0;
let done = false;
while (Date.now() - start < TIMEOUT_MS) {
  await page.waitForTimeout(1500);
  const snap = await page.evaluate((sel) => {
    const card = document.querySelector(sel);
    const lines = card?.querySelectorAll('.sample-line') || [];
    return {
      count: lines.length,
      texts: Array.from(lines).map((l) => (l.textContent || '').trim()),
      cardHtml: card?.outerHTML || '',
    };
  }, cardSelector);

  if (snap.count > lastLineCount) {
    for (let i = lastLineCount; i < snap.count; i++) {
      console.log(`  [+${Math.round((Date.now() - start) / 1000)}s] ${snap.texts[i]}`);
    }
    lastLineCount = snap.count;
  }

  const lastLine = snap.texts[snap.texts.length - 1] || '';
  // 终止条件：完成 / 中断 —— 不看 pills（上次采样残留的 pills 会误判）
  if (lastLine.includes('完成') || lastLine.includes('连接被中断') || lastLine.includes('✗')) {
    // 只有 lastLine 含 "完成（NNs）" 才算成功
    if (lastLine.includes('完成（')) {
      done = true;
      console.log('[terminal] 采样完成');
    } else if (lastLine.includes('连接被中断')) {
      console.log('[terminal] 连接被中断');
      break;
    }
    if (done) break;
  }
}

const elapsed = Math.round((Date.now() - start) / 1000);

// 最终状态 + 最后一次采样的原始 case 输出（从 SW 控制台拉的最近日志没有；重跑一次 inline）
const final = await page.evaluate(async (id) => {
  const perf = await chrome.storage.local.get(['dualang_perf_v1', 'dualang_capabilities_v1']);
  return {
    capability: perf.dualang_capabilities_v1?.[id],
    performance: perf.dualang_perf_v1?.[id],
  };
}, TARGET_ID);

console.log('\n============ 最终落盘状态 ============');
console.log(`耗时：${elapsed}s`);
console.log(`capability:`, JSON.stringify(final.capability, null, 2));
if (final.performance) {
  const rtt = final.performance.rttMs || {};
  console.log(`rttMs:`,
    `short=${rtt.short?.value ? Math.round(rtt.short.value) + 'ms' : '-'}`,
    `medium=${rtt.medium?.value ? Math.round(rtt.medium.value) + 'ms' : '-'}`,
    `long=${rtt.long?.value ? Math.round(rtt.long.value) + 'ms' : '-'}`,
  );
  console.log(`successRate=${final.performance.successRate?.value?.toFixed(2)}`);
  console.log(`qualityScore=${final.performance.qualityScore?.value?.toFixed(2)}`);
  console.log(`tokensPerSec=${Math.round(final.performance.tokensPerSec?.value || 0)}`);
}

if (done && final.capability) {
  console.log('\n✅ P3 端到端通过');
} else {
  console.log('\n⚠️  未在超时内完成或没落盘');
}
await browser.close();
