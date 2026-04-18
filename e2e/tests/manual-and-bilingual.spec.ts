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
    await popupPage.locator('#bilingualMode').evaluate((el: HTMLInputElement) => { el.checked = false; });
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

test.describe('Bilingual Mode (bilingualMode=true)', () => {
  test.beforeEach(async ({ popupPage }) => {
    await popupPage.locator('#baseUrl').fill('https://api.moonshot.cn/v1');
    await popupPage.locator('#apiKey').fill('sk-kimi-test-12345');
    await popupPage.locator('#model').fill('moonshot-v1-8k');
    await popupPage.locator('#reasoningEffort').selectOption('medium');
    await popupPage.locator('#maxTokens').fill('4096');
    await popupPage.locator('#targetLang').selectOption('zh-CN');
    await popupPage.locator('#autoTranslate').evaluate((el: HTMLInputElement) => { el.checked = true; });
    // 开启双语对照
    await popupPage.locator('#bilingualMode').evaluate((el: HTMLInputElement) => { el.checked = true; });
    await popupPage.locator('#saveBtn').click();
    await expect(popupPage.locator('#status')).toHaveText('设置已保存');
  });

  test('双语模式下翻译块应同时包含 .dualang-original 和 .dualang-para', async ({ context }) => {
    await setupApi(context, '火星将会令人惊叹。\n\n我们将让生命成为多行星物种。');
    const page = await context.newPage();
    await page.goto(mockPagePath);
    await page.setViewportSize({ width: 1280, height: 800 });

    await expect(page.locator('#tweet-1 .dualang-translation')).toBeVisible({ timeout: 5000 });

    // 应该有原文区域（tweet-1 有两个段落，取 first）
    await expect(page.locator('#tweet-1 .dualang-original').first()).toBeVisible();

    // 应该有译文区域
    await expect(page.locator('#tweet-1 .dualang-para').first()).toBeVisible();

    // 原文内容应包含英文字符（来自 tweet-1 的英文原文）
    const originalText = await page.locator('#tweet-1 .dualang-original').first().textContent();
    expect(originalText).toMatch(/[a-zA-Z]/);

    await page.close();
  });

  test('双语模式下翻译块应有 dualang-bilingual class', async ({ context }) => {
    await setupApi(context, '火星将会令人惊叹。');
    const page = await context.newPage();
    await page.goto(mockPagePath);
    await page.setViewportSize({ width: 1280, height: 800 });

    await expect(page.locator('#tweet-1 .dualang-bilingual')).toBeVisible({ timeout: 5000 });

    await page.close();
  });

  test('popup 应能保存并回显 bilingualMode=true', async ({ popupPage }) => {
    const stored = await popupPage.evaluate(async () =>
      chrome.storage.sync.get(['bilingualMode'])
    );
    expect(stored.bilingualMode).toBe(true);

    await popupPage.reload();
    await expect(popupPage.locator('#bilingualMode')).toBeChecked();
  });
});
