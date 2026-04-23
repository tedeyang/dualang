#!/usr/bin/env node
/**
 * P4 端到端实测：触发真实翻译 → 校验 recorder 在 PerformanceProfile 里落 EWMA。
 * 用 popup 的 chrome.runtime.sendMessage 走主翻译链路（handleTranslateBatch），
 * 同时读 dualang_perf_v1 看 EWMA count 是否递增。
 *
 * 默认用 SiliconFlow GLM-4-9B-0414 主条目（免费）。
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
let sw = null;
for (const ctx of ctxs) for (const w of ctx.serviceWorkers()) if (w.url().includes('background.js')) sw = w;
if (!sw) { console.log('❌ SW missing'); process.exit(2); }
const extId = new URL(sw.url()).host;
console.log(`[sw] ${extId}`);
try { await sw.evaluate(() => chrome.runtime.reload()); } catch (_) {}
await new Promise((r) => setTimeout(r, 2500));

// 重连 SW（reload 换了实例）
sw = null;
for (const ctx of ctxs) for (const w of ctx.serviceWorkers()) if (w.url().includes('background.js')) sw = w;

const ctx = ctxs[0];
const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);

// 1) 找主 provider id
const providers = await page.evaluate(() =>
  chrome.storage.sync.get(['dualang_providers_v1', 'dualang_routing_v1'])
    .then((o) => ({ list: o.dualang_providers_v1 || [], routing: o.dualang_routing_v1 })),
);
const primary = providers.routing?.primaryId || providers.list[0]?.id;
console.log(`[primary] ${primary}`);

// 2) 初始快照
const before = await page.evaluate((id) =>
  chrome.storage.local.get('dualang_perf_v1').then((o) => o.dualang_perf_v1?.[id]),
  primary,
);
console.log('[before] perf=', JSON.stringify(before ?? null).slice(0, 200));

// 3) 触发 3 条 short + 1 条 long 翻译
const texts = [
  'Good morning everyone!',
  'The meeting starts at 10am.',
  'Please bring your laptops.',
  // ~700 chars long
  'When long-context models hit production, the bottleneck shifts from parameters to plumbing. ' +
  'Engineers spend weeks tuning chunk sizes, retrieval heuristics, and caching layers. ' +
  'The model ships, but so does a fleet of ad-hoc schedulers around it. ' +
  'Rate limits become load-bearing infrastructure, not afterthoughts. ' +
  'Provider outages reveal which customers built abstractions and which wired things directly. ' +
  'Observability tells you which prompt template actually ran, but only if you logged the template id. ' +
  'The successful teams learn to treat the model like a flaky database: isolate, hedge, degrade gracefully.',
];

console.log('[translate] batch 4 条（3 short + 1 long）');
const resp = await page.evaluate(
  (t) => chrome.runtime.sendMessage({
    action: 'translate',
    payload: { texts: t, priority: 2, skipCache: true },
  }),
  texts,
);
console.log(`[translate.resp] success=${resp?.success} model=${resp?.data?.model ?? '?'}`);
if (!resp?.success) {
  console.log('[translate.err]', resp?.error);
}

// 4) 读最终快照
await page.waitForTimeout(500);
const after = await page.evaluate((id) =>
  chrome.storage.local.get('dualang_perf_v1').then((o) => o.dualang_perf_v1?.[id]),
  primary,
);
console.log('\n============ 结果 ============');
if (!after) {
  console.log('❌ 没采样到 —— perf 没写入');
} else {
  const rtt = after.rttMs || {};
  console.log(`  short.count=${rtt.short?.count ?? 0}  value=${Math.round(rtt.short?.value ?? 0)}ms`);
  console.log(`  medium.count=${rtt.medium?.count ?? 0} value=${Math.round(rtt.medium?.value ?? 0)}ms`);
  console.log(`  long.count=${rtt.long?.count ?? 0}   value=${Math.round(rtt.long?.value ?? 0)}ms`);
  console.log(`  successRate.value=${after.successRate?.value?.toFixed(2)} count=${after.successRate?.count}`);
  console.log(`  tokensPerSec.value=${Math.round(after.tokensPerSec?.value || 0)}`);
  console.log(`  lastSampleAt=${after.lastSampleAt}`);
}

const beforeCount = before?.successRate?.count || 0;
const afterCount = after?.successRate?.count || 0;
if (afterCount > beforeCount) {
  console.log(`\n✅ recorder 工作中 (successRate.count ${beforeCount} → ${afterCount})`);
} else {
  console.log(`\n❌ count 没变；recorder 可能没跑到`);
}

await browser.close();
