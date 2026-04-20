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

test('浮球始终可见（非 article-scoped）', async ({ page }) => {
  await page.goto('http://localhost:9999/e2e/fixtures/x-mock.html');
  await page.waitForTimeout(1500);
  const bubbleEl = page.locator('.dualang-bubble');
  await expect(bubbleEl).toBeVisible();
});

test('长文页面：面板里精翻按钮显示，点击触发精翻', async ({ page }) => {
  await page.goto('http://localhost:9999/e2e/fixtures/x-mock.html');
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    document.querySelector('#long-article-fixture')?.scrollIntoView();
  });
  await page.waitForTimeout(500);

  // hover 浮球唤出面板
  const bubble = page.locator('.dualang-bubble');
  await bubble.hover({ force: true });
  await page.waitForTimeout(200);

  // 精翻此文按钮应在面板里出现
  const sfBtn = page.locator('.dualang-bubble-super-fine-btn');
  await expect(sfBtn).toBeVisible({ timeout: 3_000 });

  await sfBtn.click({ force: true });

  // Slots should render immediately even before partials arrive
  const slots = page.locator('#long-article-fixture .dualang-inline-translation');
  await expect(slots.first()).toBeAttached({ timeout: 5_000 });
  await expect(slots).toHaveCount(7, { timeout: 5_000 });
});
