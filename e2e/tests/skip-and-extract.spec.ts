import { test, expect } from './fixtures';

const mockPagePath = 'http://localhost:9999/e2e/fixtures/x-mock.html';

test.describe('Skip Logic & Text Extraction', () => {
  // 设置好 API mock，仅在真的发请求时才记录
  async function setupApiMock(context: Awaited<ReturnType<typeof test['use']>> extends never ? never : any) {
    let callCount = 0;
    const translatedTweetIds: number[] = [];

    await context.route('https://api.moonshot.cn/v1/chat/completions', async (route: any) => {
      callCount++;
      const postData = JSON.parse(route.request().postData() || '{}');
      const content: string = postData.messages?.[1]?.content || '';
      const count = (content.match(/===\s*\d+\s*===|推文 \d+:|<t\d+[^>]*>/g) || []).length || 1;
      const results = [];
      for (let i = 0; i < count; i++) {
        results.push({ index: i, translated: `翻译结果 ${callCount}-${i}` });
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ results }) } }]
        }),
      });
    });

    return { getCallCount: () => callCount };
  }

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

  test('简体中文推文不应被翻译', async ({ context }) => {
    const { getCallCount } = await setupApiMock(context);
    const page = await context.newPage();
    await page.goto(mockPagePath);
    await page.setViewportSize({ width: 1280, height: 800 });

    // 让英文推文（tweet-1）先翻译完，确认系统正常工作
    await expect(page.locator('#tweet-1 .dualang-translation')).toBeVisible({ timeout: 5000 });

    // 滚动到 tweet-4（简体中文）
    await page.locator('#tweet-4').scrollIntoViewIfNeeded();
    // 等待足够时间，确认 tweet-4 没有被翻译
    await page.waitForTimeout(2000);
    await expect(page.locator('#tweet-4 .dualang-translation')).toHaveCount(0);

    await page.close();
  });

  test('繁体中文推文不应被翻译', async ({ context }) => {
    const { getCallCount } = await setupApiMock(context);
    const page = await context.newPage();
    await page.goto(mockPagePath);
    await page.setViewportSize({ width: 1280, height: 800 });

    await expect(page.locator('#tweet-1 .dualang-translation')).toBeVisible({ timeout: 5000 });

    await page.locator('#tweet-5').scrollIntoViewIfNeeded();
    await page.waitForTimeout(2000);
    await expect(page.locator('#tweet-5 .dualang-translation')).toHaveCount(0);

    await page.close();
  });

  test('纯 URL 推文不应被翻译', async ({ context }) => {
    const { getCallCount } = await setupApiMock(context);
    const page = await context.newPage();
    await page.goto(mockPagePath);
    await page.setViewportSize({ width: 1280, height: 800 });

    await expect(page.locator('#tweet-1 .dualang-translation')).toBeVisible({ timeout: 5000 });

    await page.locator('#tweet-6').scrollIntoViewIfNeeded();
    await page.waitForTimeout(2000);
    await expect(page.locator('#tweet-6 .dualang-translation')).toHaveCount(0);

    await page.close();
  });

  test('含 <img> emoji 的推文应正确提取文本并翻译', async ({ context }) => {
    const { getCallCount } = await setupApiMock(context);
    const page = await context.newPage();
    await page.goto(mockPagePath);
    await page.setViewportSize({ width: 1280, height: 800 });

    // tweet-2 含 <img alt="🔥">，需要能正确翻译（不因 img 导致文本提取失败）
    await page.locator('#tweet-2').scrollIntoViewIfNeeded();
    await expect(page.locator('#tweet-2 .dualang-translation')).toBeVisible({ timeout: 5000 });

    await page.close();
  });

  test('含 <a> 链接的推文应提取可读文本并翻译', async ({ context }) => {
    const { getCallCount } = await setupApiMock(context);
    const page = await context.newPage();
    await page.goto(mockPagePath);
    await page.setViewportSize({ width: 1280, height: 800 });

    // tweet-1 含 <a> 链接，去掉 URL 后仍有实质内容，应该被翻译
    await expect(page.locator('#tweet-1 .dualang-translation')).toBeVisible({ timeout: 5000 });

    await page.close();
  });

  test('Show more 展开后应重新翻译全文', async ({ context }) => {
    // mock 记录每次请求的内容长度
    const requestTexts: string[] = [];
    await context.route('https://api.moonshot.cn/v1/chat/completions', async (route: any) => {
      const postData = JSON.parse(route.request().postData() || '{}');
      const content: string = postData.messages?.[1]?.content || '';
      requestTexts.push(content);
      const count = (content.match(/===\s*\d+\s*===|推文 \d+:|<t\d+[^>]*>/g) || []).length || 1;
      const results = [];
      for (let i = 0; i < count; i++) {
        results.push({ index: i, translated: `展开后翻译结果 ${requestTexts.length}` });
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

    // 先让 tweet-1 翻译完成确认扩展正常
    await expect(page.locator('#tweet-1 .dualang-translation')).toBeVisible({ timeout: 5000 });

    // 滚动到 tweet-7，等待初始翻译
    await page.locator('#tweet-7').scrollIntoViewIfNeeded();
    await expect(page.locator('#tweet-7 .dualang-translation')).toBeVisible({ timeout: 5000 });

    const requestCountBeforeExpand = requestTexts.length;

    // 点击 Show more，触发展开
    await page.locator('#show-more-btn-7').click();

    // 展开后应触发新的 API 请求（debounce + API 往返）
    await expect.poll(() => requestTexts.length, { timeout: 5000 })
      .toBeGreaterThan(requestCountBeforeExpand);
    // 翻译块仍可见（可能是原节点替换）
    await expect(page.locator('#tweet-7 .dualang-translation')).toBeVisible();

    // 新请求的内容应比展开前更长
    const lastRequest = requestTexts[requestTexts.length - 1];
    expect(lastRequest).toContain('expanded text');

    await page.close();
  });
});
