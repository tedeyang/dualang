import { test, expect } from './fixtures';

const mockPagePath = 'http://localhost:9999/e2e/fixtures/x-mock.html';

test.describe('Auto Translation', () => {
  test.beforeEach(async ({ popupPage }) => {
    await popupPage.evaluate(async (s) => chrome.storage.sync.set(s), {
      baseUrl: 'https://api.moonshot.cn/v1',
      apiKey: 'sk-kimi-test-12345',
      model: 'moonshot-v1-8k',
      reasoningEffort: 'medium',
      maxTokens: 4096,
      enableStreaming: false,
    });
  });

  test('should auto-translate tweets entering viewport', async ({ context }) => {
    const page = await context.newPage();

    await context.route('https://api.moonshot.cn/v1/chat/completions', async (route) => {
      const postData = JSON.parse(route.request().postData() || '{}');
      const content = postData.messages?.[1]?.content || '';
      const count = (content.match(/===\s*\d+\s*===|推文 \d+:|<t\d+[^>]*>/g) || []).length || 1;
      const results = [];
      for (let i = 0; i < count; i++) {
        results.push({
          index: i,
          translated: i === 0 ? '火星将会令人惊叹。\n\n我们将让生命成为多行星物种。' : '自动翻译测试。'
        });
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
    await page.setViewportSize({ width: 1280, height: 800 });

    // tweet-1 进入视口后自动翻译
    await expect(page.locator('#tweet-1 .dualang-translation')).toBeVisible({ timeout: 5000 });

    // 由于页面布局和预加载边距，tweet-2 可能也在视口内；这里只验证 tweet-1 一定被翻译
    // 滚动到 tweet-3，验证动态进入视口的内容也被翻译
    await page.locator('#tweet-3').scrollIntoViewIfNeeded();
    await expect(page.locator('#tweet-3 .dualang-translation')).toBeVisible({ timeout: 5000 });
  });
});
