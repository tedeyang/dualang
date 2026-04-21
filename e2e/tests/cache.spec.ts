import { test, expect } from './fixtures';

const mockPagePath = 'http://localhost:9999/e2e/fixtures/x-mock.html';

test.describe('Translation Cache', () => {
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

  test('should use cache on repeated page load of same tweet', async ({ context }) => {
    let apiCallCount = 0;

    await context.route('https://api.moonshot.cn/v1/chat/completions', async (route) => {
      apiCallCount++;
      const postData = JSON.parse(route.request().postData() || '{}');
      const content = postData.messages?.[1]?.content || '';
      const count = (content.match(/===\s*\d+\s*===|推文 \d+:|<t\d+[^>]*>/g) || []).length || 1;
      const results = [];
      for (let i = 0; i < count; i++) {
        results.push({
          index: i,
          translated: i === 0 ? '缓存测试译文。\n\n第二段译文。' : '自动翻译测试。'
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

    // 第一次加载页面
    const page1 = await context.newPage();
    await page1.goto(mockPagePath);
    await page1.setViewportSize({ width: 1280, height: 800 });
    await expect(page1.locator('#tweet-1 .dualang-translation')).toBeVisible({ timeout: 5000 });
    expect(apiCallCount).toBeGreaterThanOrEqual(1);
    await page1.waitForTimeout(500);

    const countAfterFirst = apiCallCount;

    // 第二次加载页面（新标签页），tweet-1 应该走缓存
    const page2 = await context.newPage();
    await page2.goto(mockPagePath);
    await page2.setViewportSize({ width: 1280, height: 800 });
    await expect(page2.locator('#tweet-1 .dualang-translation')).toBeVisible({ timeout: 5000 });
    await page2.waitForTimeout(500);

    // API 调用次数不应增加（因为缓存在 storage.local 中跨页面共享）
    expect(apiCallCount).toBe(countAfterFirst);

    await page1.close();
    await page2.close();
  });

  test('虚拟 DOM 回收后，推文重现应从 ID 缓存恢复翻译（无新 API 请求）', async ({ context }) => {
    let apiCallCount = 0;

    await context.route('https://api.moonshot.cn/v1/chat/completions', async (route) => {
      apiCallCount++;
      const postData = JSON.parse(route.request().postData() || '{}');
      const content = postData.messages?.[1]?.content || '';
      const count = (content.match(/===\s*\d+\s*===|推文 \d+:|<t\d+[^>]*>/g) || []).length || 1;
      const results = [];
      for (let i = 0; i < count; i++) {
        results.push({ index: i, translated: `虚拟DOM回收测试译文${i}` });
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ results }) } }]
        }),
      });
    });

    const page = await context.newPage();
    await page.goto(mockPagePath);
    await page.setViewportSize({ width: 1280, height: 800 });

    // 等待 tweet-1 翻译完成
    await expect(page.locator('#tweet-1 .dualang-translation')).toBeVisible({ timeout: 5000 });
    const countAfterTranslate = apiCallCount;

    // 模拟虚拟 DOM 回收：移除 tweet-1 的 article 再重新添加（新 DOM 元素，同 status ID）
    await page.evaluate(() => {
      const article = document.querySelector('#tweet-1');
      if (!article) return;
      const parent = article.parentNode!;
      const html = article.outerHTML;
      article.remove();
      // 用 insertAdjacentHTML 创建新 DOM 元素（模拟 React 重新渲染）
      parent.insertAdjacentHTML('afterbegin', html);
      // 移除旧翻译块（新 DOM 不应有）
      const newArticle = document.querySelector('#tweet-1');
      newArticle?.querySelector('.dualang-translation')?.remove();
      newArticle?.querySelector('.dualang-status')?.remove();
    });

    // 新 article 应从内存 ID 缓存恢复翻译（不产生新 API 请求）
    await expect(page.locator('#tweet-1 .dualang-translation')).toBeVisible({ timeout: 3000 });
    expect(apiCallCount).toBe(countAfterTranslate);

    await page.close();
  });
});
