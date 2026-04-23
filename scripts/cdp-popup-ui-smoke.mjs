#!/usr/bin/env node
/**
 * Popup UI smoke：验证
 *   1) 翻译 tab 是默认激活
 *   2) Providers card 有编辑按钮
 *   3) 点编辑 → 表单弹出，预填 + baseUrl/model readonly
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
try { await sw.evaluate(() => chrome.runtime.reload()); } catch (_) {}
await new Promise((r) => setTimeout(r, 2500));

const ctx = ctxs[0];
const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);

// 1) 默认 tab
const defaultTab = await page.evaluate(() => {
  const active = document.querySelector('.tab-button.active');
  return active?.getAttribute('data-tab') || null;
});
console.log(`[默认 tab] ${defaultTab} ${defaultTab === 'translation' ? '✓' : '❌'}`);

// 2) 翻译 tab 里的输入框
const translationFields = await page.evaluate(() => {
  return {
    targetLang: !!document.getElementById('targetLang'),
    autoTranslate: !!document.getElementById('autoTranslate'),
    displayMode: !!document.getElementById('displayMode'),
    lineFusion: !!document.getElementById('lineFusionEnabled'),
    smartDict: !!document.getElementById('smartDictEnabled'),
    enableStreaming: !!document.getElementById('enableStreaming'),
  };
});
console.log(`[翻译 tab 字段]`, translationFields);

// 3) Providers tab
await page.click('[data-tab="providers"]');
await page.waitForTimeout(500);

const cards = await page.evaluate(() => {
  const els = document.querySelectorAll('.provider-card');
  return Array.from(els).map((c) => {
    const id = c.getAttribute('data-provider-id');
    const actions = Array.from(c.querySelectorAll('[data-action]')).map((b) => b.getAttribute('data-action'));
    return { id, actions };
  });
});
console.log(`[providers cards] ${cards.length}`);
cards.forEach((c) => console.log(`  ${c.id} actions=${c.actions.join(',')}`));

const hasEditButton = cards.every((c) => c.actions.includes('edit'));
console.log(`[编辑按钮存在于每条 card] ${hasEditButton ? '✓' : '❌'}`);

// 4) 点第一条的编辑 → 验证表单弹出 + 预填
if (cards.length) {
  await page.click(`.provider-card[data-provider-id="${cards[0].id}"] [data-action="edit"]`);
  await page.waitForTimeout(400);
  const formState = await page.evaluate(() => {
    const form = document.getElementById('providerAddForm');
    return {
      visible: form.style.display !== 'none',
      label: document.getElementById('pfLabel').value,
      baseUrl: document.getElementById('pfBaseUrl').value,
      model: document.getElementById('pfModel').value,
      baseUrlReadonly: document.getElementById('pfBaseUrl').readOnly,
      modelReadonly: document.getElementById('pfModel').readOnly,
      saveBtnText: document.getElementById('pfSaveBtn').textContent,
      keyPlaceholder: document.getElementById('pfApiKey').placeholder,
    };
  });
  console.log(`[编辑表单]`, formState);
  const okEdit = formState.visible
    && formState.baseUrlReadonly
    && formState.modelReadonly
    && formState.saveBtnText === '更新'
    && formState.label
    && formState.keyPlaceholder.includes('保留');
  console.log(`[编辑模式正确] ${okEdit ? '✓' : '❌'}`);

  // 5) 点取消复位
  await page.click('#pfCancelBtn');
  await page.waitForTimeout(200);
  const afterCancel = await page.evaluate(() => ({
    hidden: document.getElementById('providerAddForm').style.display === 'none',
    baseUrlReadonly: document.getElementById('pfBaseUrl').readOnly,
  }));
  console.log(`[取消后表单关闭且解锁]`, afterCancel);
}

await browser.close();
