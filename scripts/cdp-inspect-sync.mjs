#!/usr/bin/env node
/**
 * 一次性 debug：看 chrome.storage.sync 里 legacy apiKey/baseUrl/model 到底存了什么，
 * 帮诊断为什么 migration 没把 SF key 写到 SF provider。
 * 不保存、不改设置；只 dump。
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
if (!sw) process.exit(2);
const extId = new URL(sw.url()).host;

const ctx = ctxs[0];
const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(500);

const dump = await page.evaluate(async () => {
  const sync = await chrome.storage.sync.get(null);
  const local = await chrome.storage.local.get([
    'dualang_api_keys_v1', 'dualang_router_migration_v1',
  ]);
  const mask = (v) => {
    if (typeof v !== 'string' || !v) return v;
    if (v.length <= 10) return v.slice(0, 2) + '••••';
    return v.slice(0, 4) + '••••' + v.slice(-4);
  };
  const maskedSync = Object.fromEntries(Object.entries(sync).map(([k, v]) => {
    if (k === 'dualang_providers_v1') return [k, v]; // provider entries, no secrets
    if (k.toLowerCase().includes('key')) return [k, mask(v)];
    return [k, v];
  }));
  const maskedApiKeys = Object.fromEntries(
    Object.entries(local.dualang_api_keys_v1 || {}).map(([k, v]) => [k, mask(v)]),
  );
  return {
    syncKeys: Object.keys(sync).sort(),
    sync: maskedSync,
    apiKeysMap: maskedApiKeys,
    migrationDone: local.dualang_router_migration_v1,
  };
});

console.log(JSON.stringify(dump, null, 2));
await browser.close();
