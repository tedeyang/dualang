import { test, expect } from './fixtures';

test.describe('Popup Settings', () => {
  test('should load popup and save settings', async ({ popupPage }) => {
    await expect(popupPage.locator('h1')).toHaveText('X 光速翻译');

    await popupPage.locator('#baseUrl').fill('https://api.moonshot.cn/v1');
    await popupPage.locator('#apiKey').fill('sk-kimi-test-12345');
    await popupPage.locator('#model').fill('moonshot-v1-8k');
    await popupPage.locator('#reasoningEffort').selectOption('high');
    await popupPage.locator('#maxTokens').fill('8192');
    await popupPage.locator('#enableStreaming').evaluate((el: HTMLInputElement) => el.checked = true);

    await popupPage.locator('#saveBtn').click();
    await expect(popupPage.locator('#status')).toHaveClass(/success/);
    await expect(popupPage.locator('#status')).toHaveText('设置已保存');

    const stored = await popupPage.evaluate(async () => {
      return await chrome.storage.sync.get([
        'baseUrl', 'apiKey', 'model', 'reasoningEffort', 'maxTokens', 'enableStreaming'
      ]);
    });

    expect(stored.baseUrl).toBe('https://api.moonshot.cn/v1');
    expect(stored.apiKey).toBe('sk-kimi-test-12345');
    expect(stored.model).toBe('moonshot-v1-8k');
    expect(stored.reasoningEffort).toBe('high');
    expect(stored.maxTokens).toBe(8192);
    expect(stored.enableStreaming).toBe(true);
  });
});
