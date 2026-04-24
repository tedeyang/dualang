import { test, expect } from './fixtures';

test.describe('Popup Settings', () => {
  test('should load popup and save settings', async ({ popupPage }) => {
    await expect(popupPage.locator('h1')).toHaveText('X 光速翻译');

    await popupPage.locator('#reasoningEffort').selectOption('high');
    await popupPage.locator('#maxTokens').fill('8192');
    await popupPage.locator('#enableStreaming').evaluate((el: HTMLInputElement) => el.checked = true);

    await popupPage.locator('#saveBtn').click();
    await expect(popupPage.locator('#status')).toHaveClass(/success/);
    await expect(popupPage.locator('#status')).toHaveText('设置已保存');

    const stored = await popupPage.evaluate(async () => {
      return await chrome.storage.sync.get([
        'reasoningEffort', 'maxTokens', 'enableStreaming'
      ]);
    });

    expect(stored.reasoningEffort).toBe('high');
    expect(stored.maxTokens).toBe(8192);
    expect(stored.enableStreaming).toBe(true);
  });

  test('按行交替 + 高亮翻译 → 存 displayMode=bilingual + lineFusionEnabled=true', async ({ popupPage }) => {
    await popupPage.locator('#displaySegment [data-mode="contrast"]').click();
    await popupPage.locator('#contrastStyleRow [data-style="bilingual"]').click();
    await popupPage.locator('#saveBtn').click();
    await expect(popupPage.locator('#status')).toHaveText('设置已保存');

    const stored = await popupPage.evaluate(async () =>
      chrome.storage.sync.get(['displayMode', 'lineFusionEnabled'])
    );
    expect(stored.displayMode).toBe('bilingual');
    expect(stored.lineFusionEnabled).toBe(true);

    await popupPage.reload();
    await expect(popupPage.locator('#displaySegment [data-mode="contrast"]')).toHaveClass(/active/);
    await expect(popupPage.locator('#contrastStyleRow [data-style="bilingual"]')).toHaveClass(/active/);
  });

  test('按行交替 + 高亮原文 → 存 displayMode=append + lineFusionEnabled=true', async ({ popupPage }) => {
    await popupPage.locator('#displaySegment [data-mode="contrast"]').click();
    await popupPage.locator('#contrastStyleRow [data-style="append"]').click();
    await popupPage.locator('#saveBtn').click();
    await expect(popupPage.locator('#status')).toHaveText('设置已保存');

    const stored = await popupPage.evaluate(async () =>
      chrome.storage.sync.get(['displayMode', 'lineFusionEnabled'])
    );
    expect(stored.displayMode).toBe('append');
    expect(stored.lineFusionEnabled).toBe(true);

    await popupPage.reload();
    await expect(popupPage.locator('#displaySegment [data-mode="contrast"]')).toHaveClass(/active/);
    await expect(popupPage.locator('#contrastStyleRow [data-style="append"]')).toHaveClass(/active/);
  });

  test('整段追加 → 存 displayMode=append + lineFusionEnabled=false', async ({ popupPage }) => {
    await popupPage.locator('#displaySegment [data-mode="append"]').click();
    await popupPage.locator('#saveBtn').click();
    await expect(popupPage.locator('#status')).toHaveText('设置已保存');

    const stored = await popupPage.evaluate(async () =>
      chrome.storage.sync.get(['displayMode', 'lineFusionEnabled'])
    );
    expect(stored.displayMode).toBe('append');
    expect(stored.lineFusionEnabled).toBe(false);
  });

  test('autoTranslate seg: 手动 → autoTranslate=false', async ({ popupPage }) => {
    await popupPage.locator('#autoTranslateSeg [data-auto="false"]').click();
    await popupPage.locator('#saveBtn').click();
    await expect(popupPage.locator('#status')).toHaveText('设置已保存');

    const stored = await popupPage.evaluate(async () =>
      chrome.storage.sync.get(['autoTranslate'])
    );
    expect(stored.autoTranslate).toBe(false);

    await popupPage.reload();
    await expect(popupPage.locator('#autoTranslateSeg [data-auto="false"]')).toHaveClass(/active/);
  });
});
