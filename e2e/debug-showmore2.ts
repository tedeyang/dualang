/**
 * 调试 Show more：连续测试多个 Show more，对比每次的行为差异
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

  // 收集 Dualang 日志
  const logs: string[] = [];
  page.on('console', async (msg) => {
    const text = msg.text();
    if (!text.includes('[Dualang')) return;
    const args = msg.args();
    let detail = '';
    try {
      if (args.length >= 3) detail = JSON.stringify(await args[2].jsonValue());
    } catch (_) {}
    const line = `${text} ${detail}`;
    logs.push(line);
  });

  // 先刷新页面确保用最新代码
  console.log('刷新页面...');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await wait(6000);

  // 滚动找到 Show more 按钮，逐个测试
  console.log('开始搜索 Show more 按钮...\n');

  let tested = 0;
  const maxTests = 5;

  for (let scrollRound = 0; scrollRound < 30 && tested < maxTests; scrollRound++) {
    // 找所有可见的 Show more
    const showMoreButtons = page.locator('[data-testid="tweet-text-show-more-link"]');
    const count = await showMoreButtons.count();

    for (let btnIdx = 0; btnIdx < count && tested < maxTests; btnIdx++) {
      const btn = showMoreButtons.nth(btnIdx);
      if (!await btn.isVisible().catch(() => false)) continue;

      // 获取父 article 的信息
      const info = await btn.evaluate((el) => {
        const article = el.closest('article[data-testid="tweet"]');
        if (!article) return null;
        const textEl = article.querySelector('div[data-testid="tweetText"]');
        const statusLink = article.querySelector('a[href*="/status/"]');
        const href = statusLink?.getAttribute('href') || '';
        const idMatch = href.match(/\/status\/(\d+)/);
        return {
          tweetId: idMatch ? idMatch[1] : '(none)',
          _dualangTweetId: (article as any)._dualangTweetId || '(not set)',
          textBefore: textEl?.textContent?.slice(0, 60) || '(no text)',
          textLength: textEl?.textContent?.length || 0,
          hasTranslation: !!article.querySelector('.dualang-translation'),
          translationBefore: article.querySelector('.dualang-translation')?.textContent?.slice(0, 60) || '',
          childCount: textEl?.childNodes.length || 0,
        };
      });

      if (!info) continue;

      tested++;
      console.log(`\n${'='.repeat(60)}`);
      console.log(`测试 #${tested}: Show more`);
      console.log(`  推文 ID: ${info.tweetId}`);
      console.log(`  _dualangTweetId: ${info._dualangTweetId}`);
      console.log(`  原文 (${info.textLength}字): "${info.textBefore}..."`);
      console.log(`  翻译: ${info.hasTranslation ? `"${info.translationBefore}..."` : '(无)'}`);
      console.log(`  tweetText 子节点: ${info.childCount}`);

      // 清空日志，准备捕获点击后的事件
      logs.length = 0;

      // 点击
      await btn.click();
      console.log(`  → 已点击 Show more`);

      // 等 500ms 看 DOM 变化
      await wait(500);

      const after500 = await btn.evaluate((el) => {
        // btn 可能已被移除，找 article 通过 DOM 位置
        return null;
      }).catch(() => null);

      // 用更稳定的方式检查：通过推文 ID 找到 article
      const afterInfo = await page.evaluate((tweetId) => {
        // 遍历所有 article 找匹配的推文 ID
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        for (const article of articles) {
          const link = article.querySelector(`a[href*="/status/${tweetId}"]`);
          if (link) {
            const textEl = article.querySelector('div[data-testid="tweetText"]');
            return {
              found: true,
              textAfter: textEl?.textContent?.slice(0, 80) || '(no text)',
              textLength: textEl?.textContent?.length || 0,
              hasTranslation: !!article.querySelector('.dualang-translation'),
              translationAfter: article.querySelector('.dualang-translation')?.textContent?.slice(0, 60) || '',
              status: article.querySelector('.dualang-status')?.getAttribute('data-type') || '',
              _dualangTweetId: (article as any)._dualangTweetId || '(not set)',
            };
          }
        }
        return { found: false };
      }, info.tweetId);

      console.log(`  500ms 后:`);
      if (afterInfo.found) {
        console.log(`    文本 (${(afterInfo as any).textLength}字): "${(afterInfo as any).textAfter}..."`);
        console.log(`    文本变化: ${(afterInfo as any).textLength !== info.textLength ? `YES (${info.textLength} → ${(afterInfo as any).textLength})` : 'NO'}`);
        console.log(`    翻译: ${(afterInfo as any).hasTranslation ? `"${(afterInfo as any).translationAfter}..."` : '(无)'}`);
        console.log(`    状态: ${(afterInfo as any).status || '(无)'}`);
        console.log(`    _dualangTweetId: ${(afterInfo as any)._dualangTweetId}`);
      } else {
        console.log(`    ⚠ 未在 DOM 中找到推文 ${info.tweetId}`);
        console.log(`    当前 URL: ${page.url()}`);
      }

      // 等翻译完成
      await wait(5000);

      const afterTranslate = await page.evaluate((tweetId) => {
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        for (const article of articles) {
          const link = article.querySelector(`a[href*="/status/${tweetId}"]`);
          if (link) {
            const textEl = article.querySelector('div[data-testid="tweetText"]');
            return {
              found: true,
              textLength: textEl?.textContent?.length || 0,
              hasTranslation: !!article.querySelector('.dualang-translation'),
              translationAfter: article.querySelector('.dualang-translation')?.textContent?.slice(0, 80) || '',
              status: article.querySelector('.dualang-status')?.getAttribute('data-type') || '',
            };
          }
        }
        return { found: false };
      }, info.tweetId);

      console.log(`  5.5s 后:`);
      if (afterTranslate.found) {
        console.log(`    翻译: ${(afterTranslate as any).hasTranslation ? `"${(afterTranslate as any).translationAfter}..."` : '(无)'}`);
        console.log(`    状态: ${(afterTranslate as any).status || '(无)'}`);
        const success = (afterTranslate as any).hasTranslation && (afterTranslate as any).textLength > info.textLength;
        console.log(`    结果: ${success ? '✅ 成功' : '❌ 失败'}`);
      } else {
        console.log(`    ⚠ 推文不在 DOM 中`);
      }

      // 输出捕获的日志
      if (logs.length > 0) {
        console.log(`  相关日志 (${logs.length} 条):`);
        for (const line of logs.slice(0, 15)) {
          console.log(`    ${line.slice(0, 120)}`);
        }
        if (logs.length > 15) console.log(`    ... 还有 ${logs.length - 15} 条`);
      } else {
        console.log(`  ⚠ 无 Dualang 日志（可能未触发 MutationObserver）`);
      }
    }

    // 滚动一屏找更多
    if (tested < maxTests) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await wait(1000);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`共测试 ${tested} 个 Show more`);
  await browser.close();
}

main().catch(console.error);
