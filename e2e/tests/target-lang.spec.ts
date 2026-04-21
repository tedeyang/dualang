import { test, expect, expandAllTabPanels } from './fixtures';

const mockPagePath = 'http://localhost:9999/e2e/fixtures/x-mock.html';

test.describe('Target Language Setting', () => {
  test('popup 应能保存和读取目标语言', async ({ popupPage }) => {
    await popupPage.locator('#baseUrl').fill('https://api.moonshot.cn/v1');
    await popupPage.locator('#apiKey').fill('sk-kimi-test-12345');
    await popupPage.locator('#model').fill('moonshot-v1-8k');
    await popupPage.locator('#reasoningEffort').selectOption('medium');
    await popupPage.locator('#maxTokens').fill('4096');
    await popupPage.locator('#targetLang').selectOption('ja');
    await popupPage.locator('#saveBtn').click();
    await expect(popupPage.locator('#status')).toHaveText('设置已保存');

    const stored = await popupPage.evaluate(async () =>
      chrome.storage.sync.get(['targetLang'])
    );
    expect(stored.targetLang).toBe('ja');

    // 重新打开 popup，验证读取回显
    await popupPage.reload();
    await expect(popupPage.locator('#targetLang')).toHaveValue('ja');
  });

  test('目标语言为 zh-CN 时，API 请求应包含"简体中文"', async ({ context }) => {
    const popupPage = await context.newPage();
    await expandAllTabPanels(popupPage);
    const { extensionId } = await getExtensionId(context);
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);

    await popupPage.locator('#baseUrl').fill('https://api.moonshot.cn/v1');
    await popupPage.locator('#apiKey').fill('sk-kimi-test-12345');
    await popupPage.locator('#model').fill('moonshot-v1-8k');
    await popupPage.locator('#reasoningEffort').selectOption('medium');
    await popupPage.locator('#maxTokens').fill('4096');
    await popupPage.locator('#targetLang').selectOption('zh-CN');
    await popupPage.locator('#saveBtn').click();
    await expect(popupPage.locator('#status')).toHaveText('设置已保存');

    const requestBodies: string[] = [];
    await context.route('https://api.moonshot.cn/v1/chat/completions', async (route) => {
      const body = route.request().postData() || '';
      requestBodies.push(body);
      const count = (JSON.parse(body).messages?.[1]?.content?.match(/===\s*\d+\s*===|推文 \d+:|<t\d+[^>]*>/g) || []).length || 1;
      const results = Array.from({ length: count }, (_, i) => ({ index: i, translated: `译文${i}` }));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }),
      });
    });

    const page = await context.newPage();
    await page.goto(mockPagePath);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator('#tweet-1 .dualang-translation')).toBeVisible({ timeout: 5000 });

    expect(requestBodies.length).toBeGreaterThan(0);
    const systemPrompt = JSON.parse(requestBodies[0]).messages?.[0]?.content ?? '';
    expect(systemPrompt).toContain('简体中文');

    await page.close();
    await popupPage.close();
  });

  test('目标语言切换为 en 时，API 请求应包含"英语"', async ({ context }) => {
    const popupPage = await context.newPage();
    await expandAllTabPanels(popupPage);
    const { extensionId } = await getExtensionId(context);
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);

    await popupPage.locator('#baseUrl').fill('https://api.moonshot.cn/v1');
    await popupPage.locator('#apiKey').fill('sk-kimi-test-12345');
    await popupPage.locator('#model').fill('moonshot-v1-8k');
    await popupPage.locator('#reasoningEffort').selectOption('medium');
    await popupPage.locator('#maxTokens').fill('4096');
    await popupPage.locator('#targetLang').selectOption('en');
    await popupPage.locator('#saveBtn').click();
    await expect(popupPage.locator('#status')).toHaveText('设置已保存');

    const requestBodies: string[] = [];
    await context.route('https://api.moonshot.cn/v1/chat/completions', async (route) => {
      const body = route.request().postData() || '';
      requestBodies.push(body);
      const count = (JSON.parse(body).messages?.[1]?.content?.match(/===\s*\d+\s*===|推文 \d+:|<t\d+[^>]*>/g) || []).length || 1;
      const results = Array.from({ length: count }, (_, i) => ({ index: i, translated: `translation${i}` }));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }),
      });
    });

    // 目标语言是英文时，中文推文（tweet-4）不应被跳过（需要翻译成英文）
    // 英文推文（tweet-1）因为已经是目标语言，应该被跳过
    const page = await context.newPage();
    await page.goto(mockPagePath);
    await page.setViewportSize({ width: 1280, height: 800 });

    // 滚到 tweet-4（中文），应该被翻译（目标是英文）
    await page.locator('#tweet-4').scrollIntoViewIfNeeded();
    await expect(page.locator('#tweet-4 .dualang-translation')).toBeVisible({ timeout: 5000 });

    // 确认 API 请求里系统 prompt 包含"英语"
    expect(requestBodies.length).toBeGreaterThan(0);
    const systemPrompt = JSON.parse(requestBodies[0]).messages?.[0]?.content ?? '';
    expect(systemPrompt).toContain('英语');

    await page.close();
    await popupPage.close();
  });
});

// 辅助函数：从 context 中获取 extensionId
async function getExtensionId(context: any): Promise<{ extensionId: string }> {
  let [background] = context.serviceWorkers();
  if (!background) background = await context.waitForEvent('serviceworker');
  const extensionId = await background.evaluate(() => chrome.runtime.id);
  return { extensionId };
}
