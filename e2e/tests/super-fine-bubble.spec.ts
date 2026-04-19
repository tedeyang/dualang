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

test('点击浮球触发精翻：slot 被插入到原文段落后', async ({ page }) => {
  await page.goto('http://localhost:9999/e2e/fixtures/x-mock.html');
  await page.waitForTimeout(1500);
  // The long article is far off-screen (other tweets have margin-bottom:900px).
  // Scroll it into view so the IntersectionObserver activates the bubble.
  await page.evaluate(() => {
    document.querySelector('#long-article-fixture')?.scrollIntoView();
  });
  await page.waitForTimeout(500);
  const bubble = page.locator('.dualang-bubble');
  await expect(bubble).toBeVisible();
  // Click the bubble — this triggers translateArticleSuperFine.
  // force:true bypasses Playwright's pointer-event hit-test for fixed-positioned elements.
  await bubble.click({ force: true });
  // Slots should render immediately even before partials arrive
  // (renderInlineSlots runs before the port sends)
  const slots = page.locator('#long-article-fixture .dualang-inline-translation');
  await expect(slots.first()).toBeAttached({ timeout: 5_000 });
  // Slot count should equal the block count (7 paragraphs in fixture)
  await expect(slots).toHaveCount(7, { timeout: 5_000 });
});
