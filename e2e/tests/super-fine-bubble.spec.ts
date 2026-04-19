import { test, expect } from './fixtures';

test('长文 X Article 不触发常规自动翻译', async ({ page, extensionId }) => {
  await page.goto('http://localhost:9999/e2e/fixtures/x-mock.html');
  // Wait for content script to scan
  await page.waitForTimeout(1500);
  // The long article fixture is at #long-article-fixture
  const longArticle = page.locator('#long-article-fixture');
  await expect(longArticle).toBeVisible();
  // It should have the long-article marker attribute
  await expect(longArticle).toHaveAttribute('data-dualang-long-article', 'true');
  // And should NOT have a .dualang-translation rendered (regular flow skipped)
  const renderedTranslation = longArticle.locator('.dualang-translation');
  await expect(renderedTranslation).toHaveCount(0);
});

test('长文 X Article 存在时浮球可见', async ({ page }) => {
  await page.goto('http://localhost:9999/e2e/fixtures/x-mock.html');
  await page.waitForTimeout(1500);
  const bubbleEl = page.locator('.dualang-bubble');
  await expect(bubbleEl).toBeVisible();
});
