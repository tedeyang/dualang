import { test, expect } from './fixtures';

const mockPagePath = 'http://localhost:9999/e2e/fixtures/x-mock.html';

test.describe('Auto Translate with Scroll', () => {
  test.beforeEach(async ({ popupPage }) => {
    await popupPage.locator('#baseUrl').fill('https://api.moonshot.cn/v1');
    await popupPage.locator('#apiKey').fill('sk-kimi-test-12345');
    await popupPage.locator('#model').fill('moonshot-v1-8k');
    await popupPage.locator('#reasoningEffort').selectOption('medium');
    await popupPage.locator('#maxTokens').fill('4096');
    await popupPage.locator('#enableStreaming').evaluate((el: HTMLInputElement) => el.checked = false);
    await popupPage.locator('#saveBtn').click();
    await expect(popupPage.locator('#status')).toHaveText('设置已保存');
  });

  test('should translate tweets sequentially as they enter viewport', async ({ context }) => {
    const page = await context.newPage();

    await context.route('https://api.moonshot.cn/v1/chat/completions', async (route) => {
      const postData = JSON.parse(route.request().postData() || '{}');
      const content = postData.messages?.[1]?.content || '';
      const count = (content.match(/===\s*\d+\s*===|推文 \d+:|<t\d+[^>]*>/g) || []).length || 1;
      const results = [];
      for (let i = 0; i < count; i++) {
        results.push({ index: i, translated: '自动翻译测试。' });
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ results }) } }]
        }),
      });
    });

    await page.goto(mockPagePath);
    await page.setViewportSize({ width: 1280, height: 600 });

    // 只滚动到 tweet-2，验证 tweet-3 仍然未翻译
    await page.locator('#tweet-2').scrollIntoViewIfNeeded();
    await expect(page.locator('#tweet-2 .dualang-translation')).toBeVisible({ timeout: 5000 });

    // tweet-3 仍在视口外
    await expect(page.locator('#tweet-3 .dualang-translation')).toHaveCount(0);

    // 再滚动到 tweet-3
    await page.locator('#tweet-3').scrollIntoViewIfNeeded();
    await expect(page.locator('#tweet-3 .dualang-translation')).toBeVisible({ timeout: 5000 });
  });
});
