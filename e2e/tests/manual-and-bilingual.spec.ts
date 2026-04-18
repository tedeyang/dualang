import { test, expect } from './fixtures';

const mockPagePath = 'http://localhost:9999/e2e/fixtures/x-mock.html';

async function setupApi(context: any, translatedText = '翻译结果。') {
  await context.route('https://api.moonshot.cn/v1/chat/completions', async (route: any) => {
    const body = JSON.parse(route.request().postData() || '{}');
    const count = (body.messages?.[1]?.content?.match(/===\s*\d+\s*===|推文 \d+:/g) || []).length || 1;
    const results = Array.from({ length: count }, (_, i) => ({
      index: i,
      translated: translatedText
    }));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }),
    });
  });
}

test.describe('Manual Translate Button (autoTranslate=false)', () => {
  test.beforeEach(async ({ popupPage }) => {
    await popupPage.locator('#baseUrl').fill('https://api.moonshot.cn/v1');
    await popupPage.locator('#apiKey').fill('sk-kimi-test-12345');
    await popupPage.locator('#model').fill('moonshot-v1-8k');
    await popupPage.locator('#reasoningEffort').selectOption('medium');
    await popupPage.locator('#maxTokens').fill('4096');
    await popupPage.locator('#targetLang').selectOption('zh-CN');
    // 关闭自动翻译
    await popupPage.locator('#autoTranslate').evaluate((el: HTMLInputElement) => { el.checked = false; });
    await popupPage.locator('#displayMode').selectOption('append');
    await popupPage.locator('#saveBtn').click();
    await expect(popupPage.locator('#status')).toHaveText('设置已保存');
  });

  test('关闭自动翻译后推文应显示「译」按钮而非自动翻译', async ({ context }) => {
    await setupApi(context);
    const page = await context.newPage();
    await page.goto(mockPagePath);
    await page.setViewportSize({ width: 1280, height: 800 });

    // 等待内容脚本初始化
    await page.waitForTimeout(800);

    // 应该出现「译」按钮，而不是 .dualang-translation
    await expect(page.locator('#tweet-1 .dualang-btn')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#tweet-1 .dualang-translation')).toHaveCount(0);

    await page.close();
  });

  test('点击「译」按钮后应完成翻译并移除按钮', async ({ context }) => {
    await setupApi(context, '火星将会令人惊叹。');
    const page = await context.newPage();
    await page.goto(mockPagePath);
    await page.setViewportSize({ width: 1280, height: 800 });

    // 等待按钮出现
    await expect(page.locator('#tweet-1 .dualang-btn')).toBeVisible({ timeout: 5000 });

    // 点击按钮
    await page.locator('#tweet-1 .dualang-btn').click();

    // 按钮消失，翻译结果出现
    await expect(page.locator('#tweet-1 .dualang-translation')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#tweet-1 .dualang-btn')).toHaveCount(0);
    await expect(page.locator('#tweet-1 .dualang-translation')).toContainText('火星将会令人惊叹。');

    await page.close();
  });

  test('popup 应能保存并回显 autoTranslate=false', async ({ popupPage }) => {
    const stored = await popupPage.evaluate(async () =>
      chrome.storage.sync.get(['autoTranslate'])
    );
    expect(stored.autoTranslate).toBe(false);

    await popupPage.reload();
    await expect(popupPage.locator('#autoTranslate')).not.toBeChecked();
  });
});

async function saveDisplayMode(popupPage: any, mode: 'append' | 'translation-only' | 'inline' | 'bilingual') {
  await popupPage.locator('#baseUrl').fill('https://api.moonshot.cn/v1');
  await popupPage.locator('#apiKey').fill('sk-kimi-test-12345');
  await popupPage.locator('#model').fill('moonshot-v1-8k');
  await popupPage.locator('#reasoningEffort').selectOption('medium');
  await popupPage.locator('#maxTokens').fill('4096');
  await popupPage.locator('#targetLang').selectOption('zh-CN');
  await popupPage.locator('#autoTranslate').evaluate((el: HTMLInputElement) => { el.checked = true; });
  await popupPage.locator('#displayMode').selectOption(mode);
  await popupPage.locator('#saveBtn').click();
  await expect(popupPage.locator('#status')).toHaveText('设置已保存');
}

test.describe('Display Mode: append（默认，原文保留 + 译文附加）', () => {
  test.beforeEach(async ({ popupPage }) => saveDisplayMode(popupPage, 'append'));

  test('append 模式下原文 tweetText 仍可见', async ({ context }) => {
    await setupApi(context, '火星将会令人惊叹。');
    const page = await context.newPage();
    await page.goto(mockPagePath);
    await page.setViewportSize({ width: 1280, height: 800 });

    await expect(page.locator('#tweet-1 .dualang-translation')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#tweet-1 [data-testid="tweetText"]')).toBeVisible();
    const attr = await page.locator('#tweet-1').getAttribute('data-dualang-mode');
    expect(attr).toBe('append');

    await page.close();
  });
});

test.describe('Display Mode: translation-only（隐藏原文）', () => {
  test.beforeEach(async ({ popupPage }) => saveDisplayMode(popupPage, 'translation-only'));

  test('translation-only 模式下原文 tweetText 被 CSS 隐藏', async ({ context }) => {
    await setupApi(context, '火星将会令人惊叹。');
    const page = await context.newPage();
    await page.goto(mockPagePath);
    await page.setViewportSize({ width: 1280, height: 800 });

    await expect(page.locator('#tweet-1 .dualang-translation')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#tweet-1 [data-testid="tweetText"]')).toBeHidden();
    // 译文段落仍然渲染
    await expect(page.locator('#tweet-1 .dualang-para').first()).toBeVisible();

    await page.close();
  });
});

test.describe('Display Mode: inline（段落对照）', () => {
  test.beforeEach(async ({ popupPage }) => saveDisplayMode(popupPage, 'inline'));

  test('inline 模式下每段原文克隆 + 译文交错', async ({ context }) => {
    await setupApi(context, '火星将会令人惊叹。\n\n我们将让生命成为多行星物种。');
    const page = await context.newPage();
    await page.goto(mockPagePath);
    await page.setViewportSize({ width: 1280, height: 800 });

    await expect(page.locator('#tweet-1 .dualang-translation.dualang-inline')).toBeVisible({ timeout: 5000 });
    // 原文 tweetText 隐藏，克隆后的原文 HTML 块可见
    await expect(page.locator('#tweet-1 [data-testid="tweetText"]')).toBeHidden();
    await expect(page.locator('#tweet-1 .dualang-original-html').first()).toBeVisible();
    // 克隆的原文保留英文字符（来自 tweet-1 的 textHtml）
    const origText = await page.locator('#tweet-1 .dualang-original-html').first().textContent();
    expect(origText).toMatch(/[a-zA-Z]/);

    await page.close();
  });
});

test.describe('Display Mode: bilingual（整体对照）', () => {
  test.beforeEach(async ({ popupPage }) => saveDisplayMode(popupPage, 'bilingual'));

  test('bilingual 模式下有 dualang-bilingual class 和 克隆原文块', async ({ context }) => {
    await setupApi(context, '火星将会令人惊叹。');
    const page = await context.newPage();
    await page.goto(mockPagePath);
    await page.setViewportSize({ width: 1280, height: 800 });

    await expect(page.locator('#tweet-1 .dualang-bilingual')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#tweet-1 [data-testid="tweetText"]')).toBeHidden();
    await expect(page.locator('#tweet-1 .dualang-original-html')).toBeVisible();

    await page.close();
  });
});

test.describe('Display Mode: 持久化与迁移', () => {
  test('保存 displayMode=inline 后刷新回显', async ({ popupPage }) => {
    await saveDisplayMode(popupPage, 'inline');
    const stored = await popupPage.evaluate(async () =>
      chrome.storage.sync.get(['displayMode'])
    );
    expect(stored.displayMode).toBe('inline');

    await popupPage.reload();
    await expect(popupPage.locator('#displayMode')).toHaveValue('inline');
  });

  test('老 bilingualMode=true 在未设 displayMode 时迁移为 inline', async ({ popupPage }) => {
    // 清掉 displayMode，只留旧 bilingualMode=true，模拟老用户配置
    await popupPage.evaluate(async () => {
      await chrome.storage.sync.set({ bilingualMode: true });
      await chrome.storage.sync.remove('displayMode');
    });
    await popupPage.reload();
    await expect(popupPage.locator('#displayMode')).toHaveValue('inline');
  });
});
