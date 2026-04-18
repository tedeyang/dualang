/**
 * 不刷新页面，在已翻译的推文上测试 Show more
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

  // 收集日志
  const logs: string[] = [];
  page.on('console', async (msg) => {
    const text = msg.text();
    if (!text.includes('[Dualang')) return;
    const args = msg.args();
    let detail = '';
    try { if (args.length >= 3) detail = JSON.stringify(await args[2].jsonValue()); } catch (_) {}
    logs.push(`${text} ${detail}`);
    console.log(`  [LOG] ${text.slice(0, 80)} ${detail.slice(0, 80)}`);
  });

  // 找到已翻译且有 Show more 的推文
  const candidates = await page.evaluate(() => {
    const results: any[] = [];
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    articles.forEach((article, i) => {
      const showMore = article.querySelector('[data-testid="tweet-text-show-more-link"]');
      const translation = article.querySelector('.dualang-translation');
      const textEl = article.querySelector('div[data-testid="tweetText"]');
      const statusLink = article.querySelector('a[href*="/status/"]');
      const href = statusLink?.getAttribute('href') || '';
      const idMatch = href.match(/\/status\/(\d+)/);
      const statusEl = article.querySelector('.dualang-status');
      results.push({
        index: i,
        tweetId: idMatch?.[1] || '(none)',
        hasShowMore: !!showMore,
        hasTranslation: !!translation,
        translationText: translation?.textContent?.slice(0, 50) || '',
        originalText: textEl?.textContent?.slice(0, 50) || '',
        originalLength: textEl?.textContent?.length || 0,
        statusType: statusEl?.dataset?.type || '',
        inTranslatingSet: false, // can't check from main world
      });
    });
    return results;
  });

  console.log(`找到 ${candidates.length} 条推文:\n`);
  const withShowMore = candidates.filter(c => c.hasShowMore);
  const translatedWithShowMore = withShowMore.filter(c => c.hasTranslation);
  const untranslatedWithShowMore = withShowMore.filter(c => !c.hasTranslation);

  console.log(`有 Show more 的: ${withShowMore.length} (已翻译: ${translatedWithShowMore.length}, 未翻译: ${untranslatedWithShowMore.length})`);

  for (const c of withShowMore) {
    console.log(`  [${c.index}] id=${c.tweetId} translated=${c.hasTranslation} status="${c.statusType}" text="${c.originalText}..."`);
    if (c.hasTranslation) console.log(`       翻译: "${c.translationText}..."`);
  }

  // 优先测试已翻译的 Show more
  const target = translatedWithShowMore[0] || untranslatedWithShowMore[0];
  if (!target) {
    console.log('\n没有可测试的 Show more 推文');
    await browser.close();
    return;
  }

  console.log(`\n=== 测试推文 [${target.index}] id=${target.tweetId} ===`);
  console.log(`  点击前原文 (${target.originalLength}字): "${target.originalText}..."`);
  console.log(`  点击前翻译: ${target.hasTranslation ? `"${target.translationText}..."` : '(无)'}`);

  // 点击 Show more
  logs.length = 0;
  const showMoreBtn = page.locator(`article:nth-child(${target.index + 1}) [data-testid="tweet-text-show-more-link"]`);

  // 如果用 nth-child 找不到，用推文 ID 找
  let btn = showMoreBtn;
  if (!await btn.isVisible().catch(() => false)) {
    // 遍历所有 show more 按钮找到匹配推文 ID 的
    const allBtns = page.locator('[data-testid="tweet-text-show-more-link"]');
    const count = await allBtns.count();
    for (let i = 0; i < count; i++) {
      const b = allBtns.nth(i);
      const matches = await b.evaluate((el, tid) => {
        const art = el.closest('article[data-testid="tweet"]');
        const link = art?.querySelector(`a[href*="/status/${tid}"]`);
        return !!link;
      }, target.tweetId);
      if (matches) { btn = b; break; }
    }
  }

  console.log('\n--- 点击 Show more ---');
  await btn.click();

  // 检查时间序列
  for (const checkpoint of [200, 500, 1000, 3000, 8000, 15000]) {
    const elapsed = checkpoint;
    await wait(checkpoint === 200 ? 200 : checkpoint - (checkpoint === 500 ? 200 : checkpoint === 1000 ? 500 : checkpoint === 3000 ? 1000 : checkpoint === 8000 ? 3000 : 8000));

    const state = await page.evaluate((tid) => {
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      for (const article of articles) {
        const link = article.querySelector(`a[href*="/status/${tid}"]`);
        if (!link) continue;
        const textEl = article.querySelector('div[data-testid="tweetText"]');
        const trans = article.querySelector('.dualang-translation');
        const status = article.querySelector('.dualang-status');
        return {
          found: true,
          textLength: textEl?.textContent?.length || 0,
          hasTranslation: !!trans,
          translationText: trans?.textContent?.slice(0, 60) || '',
          statusType: status?.getAttribute('data-type') || '',
          hasShowMore: !!article.querySelector('[data-testid="tweet-text-show-more-link"]'),
        };
      }
      return { found: false };
    }, target.tweetId);

    if (!state.found) {
      console.log(`  ${elapsed}ms: ⚠ 推文不在 DOM (可能页面导航了)`);
      break;
    }
    const s = state as any;
    const textChanged = s.textLength !== target.originalLength;
    console.log(`  ${elapsed}ms: text=${s.textLength}字${textChanged ? '(变了)' : ''} translated=${s.hasTranslation} status="${s.statusType}" showMore=${s.hasShowMore}`);
    if (s.hasTranslation && textChanged) {
      console.log(`    ✅ 翻译已刷新: "${s.translationText}..."`);
      break;
    }
  }

  console.log(`\n捕获的日志 (${logs.length} 条):`);
  for (const line of logs) {
    console.log(`  ${line.slice(0, 140)}`);
  }

  await browser.close();
}

main().catch(console.error);
