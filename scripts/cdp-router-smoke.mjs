#!/usr/bin/env node
/**
 * Router MVP smoke：连 9222 → 重载扩展 → 开 popup → 切 Providers tab → dump 列表。
 * 不主动点"测试"（消耗 token），只验证 P1+P2 端到端：
 *   - migration 迁移到位（providers[] 有条目）
 *   - Providers tab 正确 render 条目 + pills
 *   - api key 脱敏正确（"••••" 而非明文）
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

// 1) 找扩展 SW 拿 extension id，顺便 reload
let sw = null;
for (const ctx of ctxs) for (const w of ctx.serviceWorkers()) if (w.url().includes('background.js')) sw = w;
if (!sw) { console.log('❌ 找不到 dualang background.js SW —— 确认扩展已加载'); process.exit(2); }
const extId = new URL(sw.url()).host;
console.log(`[sw] extension id = ${extId}`);
console.log('[reload] chrome.runtime.reload()');
try { await sw.evaluate(() => chrome.runtime.reload()); } catch (_) {}
await new Promise((r) => setTimeout(r, 2000));

// 重启后 SW 重新接一次
sw = null;
for (const ctx of ctxs) for (const w of ctx.serviceWorkers()) if (w.url().includes('background.js')) sw = w;
if (sw) {
  sw.on('console', (c) => {
    const t = c.text();
    if (t.includes('[router]')) console.log('  SW ▶', t.slice(0, 220));
  });
}

// 2) 找已有 context 开一个 popup tab
const ctx = ctxs[0];
const popupUrl = `chrome-extension://${extId}/popup.html`;
console.log(`[nav] 打开 ${popupUrl}`);
const page = await ctx.newPage();
page.on('console', (c) => {
  const t = c.text();
  if (t.includes('router') || t.includes('provider') || t.includes('migration')) {
    console.log('  PG ▶', t.slice(0, 200));
  }
});
await page.goto(popupUrl, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

// 3) 切 Providers tab
console.log('[click] Providers tab');
await page.click('[data-tab="providers"]');
await page.waitForTimeout(800);

// 4) Dump 列表
const snapshot = await page.evaluate(() => {
  const cards = document.querySelectorAll('.provider-card');
  return Array.from(cards).map((c) => ({
    id: c.getAttribute('data-provider-id'),
    label: c.querySelector('.provider-card__label')?.textContent?.trim() || '',
    sub: Array.from(c.querySelectorAll('.provider-card__sub')).map(
      (e) => e.textContent?.trim() || '',
    ),
    pills: Array.from(c.querySelectorAll('.pill')).map((p) => p.textContent?.trim() || ''),
    disabled: c.classList.contains('is-disabled'),
  }));
});

console.log('\n============ Providers tab 内容 ============');
if (!snapshot.length) {
  console.log('❌ 空列表 —— migration 没跑或 Providers tab 没激活');
} else {
  snapshot.forEach((card, i) => {
    console.log(`\n[${i + 1}] ${card.label}`);
    console.log(`    id: ${card.id}`);
    card.sub.forEach((s) => console.log(`    ${s}`));
    console.log(`    pills: [${card.pills.join(' | ')}]`);
    console.log(`    disabled: ${card.disabled}`);
  });
}

// 5) 校验 API key 脱敏
const hasPlaintextKey = await page.evaluate(() => {
  const html = document.getElementById('providerList')?.innerHTML || '';
  // 真实 sk-... key 通常 > 20 字符；脱敏后是 "sk-1••••xxxx"
  return /sk-[a-zA-Z0-9]{20,}/.test(html);
});
if (hasPlaintextKey) {
  console.log('\n❌ API Key 明文泄漏到 DOM —— maskApiKey 有漏');
} else {
  console.log('\n✓ API Key 脱敏正常');
}

// 6) Migration 版本戳
const migrationState = await page.evaluate(() => {
  return chrome.storage.local.get(['dualang_router_migration_v1', 'dualang_providers_v1']);
});
console.log('\n============ 存储状态 ============');
console.log(`local.dualang_router_migration_v1 = ${migrationState.dualang_router_migration_v1}`);

const syncState = await page.evaluate(() => chrome.storage.sync.get(['dualang_providers_v1']));
console.log(`sync.dualang_providers_v1.length = ${syncState.dualang_providers_v1?.length ?? 0}`);

await page.waitForTimeout(500);
await browser.close();
console.log('\n✅ smoke done');
