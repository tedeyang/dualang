/**
 * 调试 Show more：连接 CDP 浏览器，监听 perf 日志，
 * 滚动找到 Show more 按钮并点击，观察翻译刷新行为。
 */
import { chromium, type Page } from '@playwright/test';

async function wait(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const context = browser.contexts()[0];
  let page: Page | null = null;
  for (const p of context.pages()) {
    if (p.url().includes('x.com')) { page = p; break; }
  }
  if (!page) { console.error('No x.com page'); return; }

  console.log('=== 连接到', page.url(), '===\n');

  // 收集所有 Dualang 日志
  page.on('console', async (msg) => {
    const text = msg.text();
    if (!text.includes('[Dualang')) return;
    const args = msg.args();
    let detail = '';
    try {
      if (args.length >= 3) {
        detail = JSON.stringify(await args[2].jsonValue());
      }
    } catch (_) {}
    console.log(`[LOG] ${text} ${detail}`);
  });

  // Step 1: 检查当前视口内的翻译状态
  const before = await page.evaluate(() => {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    const info: any[] = [];
    articles.forEach((a, i) => {
      const textEl = a.querySelector('div[data-testid="tweetText"]');
      const text = textEl?.textContent?.slice(0, 60) || '(no text)';
      const hasTranslation = !!a.querySelector('.dualang-translation');
      const translationText = a.querySelector('.dualang-translation')?.textContent?.slice(0, 60) || '';
      const status = a.querySelector('.dualang-status')?.getAttribute('data-type') || '';
      info.push({ i, text, hasTranslation, translationText, status });
    });
    return info;
  });
  console.log('=== 当前推文状态 ===');
  before.forEach(t => console.log(`  [${t.i}] translated=${t.hasTranslation} status=${t.status} text="${t.text}"`));

  // Step 2: 找 Show more 按钮
  console.log('\n=== 查找 Show more 按钮 ===');

  // X.com 的 Show more 可能有多种形式
  const showMoreSelectors = [
    'article [data-testid="tweet-text-show-more-link"]',
    'article button:has-text("Show more")',
    'article span:has-text("Show more")',
    'article [role="link"]:has-text("Show more")',
    'article a:has-text("Show")',
  ];

  let found = false;
  for (const sel of showMoreSelectors) {
    const count = await page.locator(sel).count();
    if (count > 0) {
      console.log(`  找到 "${sel}" x${count}`);
      found = true;
    }
  }

  if (!found) {
    // 滚动找
    console.log('  视口内未找到，向下滚动...');
    for (let i = 0; i < 15; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await wait(800);
      for (const sel of showMoreSelectors) {
        const count = await page.locator(sel).count();
        if (count > 0) {
          console.log(`  滚动 ${i + 1} 屏后找到 "${sel}" x${count}`);
          found = true;
          break;
        }
      }
      if (found) break;
    }
  }

  if (!found) {
    console.log('  未找到 Show more，检查 X.com DOM 结构...');
    // 打印所有 article 内的 button/a 文本
    const buttons = await page.evaluate(() => {
      const results: string[] = [];
      document.querySelectorAll('article button, article a[role="link"]').forEach(el => {
        const text = el.textContent?.trim();
        if (text && text.length < 30) results.push(`<${el.tagName.toLowerCase()}> "${text}"`);
      });
      return [...new Set(results)];
    });
    console.log('  article 内按钮/链接:', buttons);
    await browser.close();
    return;
  }

  // Step 3: 找到最近的 Show more 并准备点击
  const showMoreBtn = page.locator('[data-testid="tweet-text-show-more-link"]').first();
  const btnVisible = await showMoreBtn.isVisible().catch(() => false);

  let targetBtn = btnVisible ? showMoreBtn : null;
  if (!targetBtn) {
    for (const sel of showMoreSelectors) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) {
        targetBtn = loc;
        break;
      }
    }
  }

  if (!targetBtn) {
    console.log('  Show more 不可见');
    await browser.close();
    return;
  }

  // 获取点击前的推文信息
  const parentArticle = targetBtn.locator('xpath=ancestor::article[@data-testid="tweet"]');
  const beforeClick = await parentArticle.evaluate((article) => {
    const textEl = article.querySelector('div[data-testid="tweetText"]');
    return {
      text: textEl?.textContent || '',
      hasTranslation: !!article.querySelector('.dualang-translation'),
      translationText: article.querySelector('.dualang-translation')?.textContent || '',
      childCount: textEl?.childNodes.length || 0,
      innerHTML: textEl?.innerHTML?.slice(0, 300) || ''
    };
  });
  console.log('\n=== 点击前推文状态 ===');
  console.log('  原文 (前80字):', beforeClick.text.slice(0, 80));
  console.log('  翻译:', beforeClick.hasTranslation ? beforeClick.translationText.slice(0, 80) : '(无)');
  console.log('  tweetText 子节点数:', beforeClick.childCount);

  // Step 4: 点击 Show more
  console.log('\n=== 点击 Show more ===');
  await targetBtn.click();

  // 等待 DOM 更新
  await wait(500);

  const afterClick500 = await parentArticle.evaluate((article) => {
    const textEl = article.querySelector('div[data-testid="tweetText"]');
    return {
      text: textEl?.textContent || '',
      hasTranslation: !!article.querySelector('.dualang-translation'),
      translationText: article.querySelector('.dualang-translation')?.textContent || '',
      childCount: textEl?.childNodes.length || 0,
      statusType: article.querySelector('.dualang-status')?.getAttribute('data-type') || ''
    };
  }).catch(() => null);

  if (afterClick500) {
    console.log('\n=== 点击后 500ms ===');
    console.log('  原文 (前80字):', afterClick500.text.slice(0, 80));
    console.log('  翻译:', afterClick500.hasTranslation ? afterClick500.translationText.slice(0, 80) : '(无)');
    console.log('  状态:', afterClick500.statusType || '(无)');
    console.log('  tweetText 子节点数:', afterClick500.childCount);
    console.log('  文本变化:', afterClick500.text !== beforeClick.text ? 'YES' : 'NO');
    console.log('  文本长度:', beforeClick.text.length, '→', afterClick500.text.length);
  } else {
    console.log('  ⚠ 点击后 article 可能消失（导航到推文详情页？）');
    console.log('  当前 URL:', page.url());
  }

  // 等待翻译完成
  await wait(5000);

  const afterTranslate = await parentArticle.evaluate((article) => {
    const textEl = article.querySelector('div[data-testid="tweetText"]');
    return {
      text: textEl?.textContent || '',
      hasTranslation: !!article.querySelector('.dualang-translation'),
      translationText: article.querySelector('.dualang-translation')?.textContent || '',
      statusType: article.querySelector('.dualang-status')?.getAttribute('data-type') || ''
    };
  }).catch(() => null);

  if (afterTranslate) {
    console.log('\n=== 点击后 5.5s ===');
    console.log('  翻译:', afterTranslate.hasTranslation ? afterTranslate.translationText.slice(0, 120) : '(无)');
    console.log('  状态:', afterTranslate.statusType || '(无)');
  } else {
    console.log('\n  ⚠ article 不在 DOM 中');
    console.log('  当前 URL:', page.url());
  }

  console.log('\n=== 完成 ===');
  await browser.close();
}

main().catch(console.error);
