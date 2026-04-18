import { test as base, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import path from 'path';

const extensionPath = path.resolve(__dirname, '../..'); // dualang root

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
  popupPage: Page;
}>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      // Chrome 扩展的 headless 必须用 --headless=new arg，不能用 headless:true
      // 否则 Service Worker 无法注册（Chromium 限制）
      headless: false,
      args: [
        '--headless=new',
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-first-run',
        '--disable-default-apps',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
      ],
    });
    await use(context);
    await context.close();
  },

  extensionId: async ({ context }, use) => {
    // 等待 Service Worker 注册完成
    let [background] = context.serviceWorkers();
    if (!background) {
      background = await context.waitForEvent('serviceworker');
    }
    const id = await background.evaluate(() => chrome.runtime.id);
    await use(id);
  },

  popupPage: async ({ context, extensionId }, use) => {
    const popupUrl = `chrome-extension://${extensionId}/popup.html`;
    const page = await context.newPage();
    await expandAllTabPanels(page);
    await page.goto(popupUrl);
    await use(page);
  },
});

/**
 * 让 popup 的所有 tab-panel 在测试环境下始终可见。不再依赖用户点击 tab 按钮，避免
 * Playwright 的 actionability 检查在 display:none 元素上失败。
 * 线上行为：tab-button 按 data-tab 切换 active 类；测试环境：始终全展开（!important）。
 * 对任何新建的 page 调用即可；对 chrome-extension:// 下的 popup 有效。
 */
export async function expandAllTabPanels(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const inject = () => {
      if (document.getElementById('__dualang_test_expand_tabs')) return;
      const style = document.createElement('style');
      style.id = '__dualang_test_expand_tabs';
      style.textContent = '.tab-panel { display: block !important; }';
      (document.head || document.documentElement).appendChild(style);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', inject);
    } else {
      inject();
    }
    new MutationObserver(inject).observe(document.documentElement, { childList: true, subtree: true });
  });
}

export const expect = test.expect;
