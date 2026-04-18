/**
 * Dualang 压力测试 — 连接已打开的浏览器 (CDP 9222)
 *
 * 10 种场景，目标 ~100 次翻译请求，收集 [Dualang:perf] 日志分析性能。
 *
 * 用法: cd e2e && npx playwright test stress-test.ts --config stress.config.ts
 */
import { chromium, type Page, type CDPSession } from '@playwright/test';

// ============ 配置 ============
const CDP_URL = 'http://localhost:9222';
const SCROLL_PAUSE = 1000;  // 滚动后等待 ms
const SETTLE_TIME = 5000;   // 等待翻译完成 ms

// ============ 日志收集 ============
interface PerfEntry {
  ts: number;
  event: string;
  data: Record<string, any>;
  scenario: string;
}

const perfLog: PerfEntry[] = [];
const apiLog: { scenario: string; ts: number; rttMs: number; subBatchSize: number; error?: string }[] = [];
let currentScenario = '';

function attachLogger(page: Page) {
  page.on('console', async (msg) => {
    const text = msg.text();
    if (!text.includes('[Dualang:perf]')) return;

    // msg.args(): [string, string, object] → '[Dualang:perf]', eventName, dataObject
    const args = msg.args();
    let event = '';
    let data: Record<string, any> = {};

    try {
      if (args.length >= 3) {
        event = await args[1].jsonValue() as string;
        data = await args[2].jsonValue() as Record<string, any>;
      } else if (args.length === 2) {
        event = await args[1].jsonValue() as string;
      } else {
        // fallback: parse text
        const match = text.match(/\[Dualang:perf\]\s+(\S+)\s*(.*)/);
        if (match) {
          event = match[1];
          try { data = JSON.parse(match[2]); } catch (_) {}
        }
      }
    } catch (_) {
      const match = text.match(/\[Dualang:perf\]\s+(\S+)/);
      if (match) event = match[1];
    }

    if (!event) return;
    perfLog.push({ ts: Date.now(), event, data, scenario: currentScenario });

    if (event === 'apiSuccess' || event === 'streamDone') {
      apiLog.push({
        scenario: currentScenario,
        ts: Date.now(),
        rttMs: parseFloat(data.rttMs) || 0,
        subBatchSize: data.subBatchSize || data.batchSize || 0
      });
    }
    if (event === 'apiError') {
      apiLog.push({
        scenario: currentScenario,
        ts: Date.now(),
        rttMs: parseFloat(data.rttMs) || 0,
        subBatchSize: data.subBatchSize || 0,
        error: data.error
      });
    }
  });
}

// ============ 辅助函数 ============
async function wait(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function countTranslations(page: Page): Promise<number> {
  return page.locator('.dualang-translation').count();
}

async function countPending(page: Page): Promise<number> {
  return page.locator('.dualang-status').count();
}

async function scrollToBottom(page: Page, steps = 5) {
  for (let i = 0; i < steps; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await wait(SCROLL_PAUSE);
  }
}

async function scrollToTop(page: Page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await wait(SCROLL_PAUSE);
}

async function scrollTo(page: Page, y: number) {
  await page.evaluate((pos) => window.scrollTo(0, pos), y);
  await wait(SCROLL_PAUSE);
}

async function waitForTranslations(page: Page, minCount: number, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const count = await countTranslations(page);
    if (count >= minCount) return count;
    await wait(500);
  }
  return countTranslations(page);
}

async function getScrollHeight(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollHeight);
}

// ============ 场景 ============

/** S1: 首页加载 — 首屏推文自动翻译 */
async function s1_initialLoad(page: Page) {
  currentScenario = 'S1_initialLoad';
  console.log('\n=== S1: 首页加载 ===');
  // 刷新页面，等待 DOM 加载（X.com 永远不会 networkidle）
  await page.reload({ waitUntil: 'domcontentloaded' });
  await wait(8000); // X.com 首屏推文需要较长时间渲染
  const count = await countTranslations(page);
  console.log(`  首屏翻译块: ${count}`);
}

/** S2: 慢速向下滚动 — 逐屏加载 */
async function s2_slowScrollDown(page: Page) {
  currentScenario = 'S2_slowScroll';
  console.log('\n=== S2: 慢速向下滚动 (5 屏) ===');
  const before = await countTranslations(page);
  await scrollToBottom(page, 5);
  await wait(SETTLE_TIME);
  const after = await countTranslations(page);
  console.log(`  翻译块: ${before} → ${after} (新增 ${after - before})`);
}

/** S3: 快速上下滚动 — 压力测试 Observer */
async function s3_rapidScroll(page: Page) {
  currentScenario = 'S3_rapidScroll';
  console.log('\n=== S3: 快速上下滚动 (10 次) ===');
  const before = await countTranslations(page);
  const height = await getScrollHeight(page);
  for (let i = 0; i < 10; i++) {
    const target = Math.random() * height;
    await page.evaluate((y) => window.scrollTo(0, y), target);
    await wait(150); // 快速！
  }
  await wait(SETTLE_TIME);
  const after = await countTranslations(page);
  console.log(`  翻译块: ${before} → ${after} (新增 ${after - before})`);
}

/** S4: 回到顶部 — 验证缓存恢复 */
async function s4_backToTop(page: Page) {
  currentScenario = 'S4_backToTop';
  console.log('\n=== S4: 回到顶部 (缓存恢复) ===');
  await scrollToTop(page);
  await wait(SETTLE_TIME);
  const count = await countTranslations(page);
  // 收集 cacheRestored 数据
  const restoreEvents = perfLog.filter(e => e.scenario === 'S4_backToTop' && e.event === 'scanAndQueue' && e.data.cacheRestored > 0);
  const restored = restoreEvents.reduce((sum, e) => sum + (e.data.cacheRestored || 0), 0);
  console.log(`  视口内翻译块: ${count}, ID 缓存恢复: ${restored}`);
}

/** S5: 点击 Show more（如果页面上有） */
async function s5_showMore(page: Page) {
  currentScenario = 'S5_showMore';
  console.log('\n=== S5: 点击 Show more ===');
  // X.com 的 Show more 按钮文本
  const showMoreBtn = page.locator('button:has-text("Show more"), [data-testid="tweet-text-show-more-link"]').first();
  const visible = await showMoreBtn.isVisible().catch(() => false);
  if (visible) {
    await showMoreBtn.click();
    await wait(SETTLE_TIME);
    const showMoreEvents = perfLog.filter(e => e.scenario === 'S5_showMore' && e.event === 'scanAndQueue');
    console.log(`  Show more 点击后扫描事件: ${showMoreEvents.length}`);
  } else {
    // 滚动找 Show more
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await wait(600);
      const btn = page.locator('button:has-text("Show more"), [data-testid="tweet-text-show-more-link"]').first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        await wait(SETTLE_TIME);
        console.log(`  找到并点击 Show more (滚动 ${i + 1} 屏)`);
        return;
      }
    }
    console.log('  未找到 Show more 按钮，跳过');
  }
}

/** S6: 继续向下滚动更多内容 */
async function s6_deepScroll(page: Page) {
  currentScenario = 'S6_deepScroll';
  console.log('\n=== S6: 深度向下滚动 (15 屏) ===');
  const before = await countTranslations(page);
  await scrollToBottom(page, 15);
  await wait(SETTLE_TIME);
  const after = await countTranslations(page);
  console.log(`  翻译块: ${before} → ${after} (新增 ${after - before})`);
}

/** S7: 后退再前进 (history navigation) */
async function s7_backForward(page: Page) {
  currentScenario = 'S7_backForward';
  console.log('\n=== S7: 后退再前进 ===');
  // 点击某条推文进入详情
  // 找推文时间戳链接（排除 analytics 等非推文详情链接）
  const tweetLink = page.locator('article a[href*="/status/"]:not([href*="analytics"])').first();
  const linkVisible = await tweetLink.isVisible().catch(() => false);
  if (linkVisible) {
    const href = await tweetLink.getAttribute('href');
    console.log(`  点击推文链接: ${href}`);
    await tweetLink.click();
    await wait(SETTLE_TIME);
    const detailCount = await countTranslations(page);
    console.log(`  详情页翻译块: ${detailCount}`);

    // 后退
    await page.goBack();
    await wait(SETTLE_TIME);
    const backCount = await countTranslations(page);
    console.log(`  后退后翻译块: ${backCount}`);
  } else {
    console.log('  未找到推文链接，跳过');
  }
}

/** S8: 页面内导航到不同 tab (For you / Following) */
async function s8_tabSwitch(page: Page) {
  currentScenario = 'S8_tabSwitch';
  console.log('\n=== S8: Tab 切换 (For you ↔ Following) ===');
  const tabs = page.locator('[role="tab"]');
  const tabCount = await tabs.count();
  if (tabCount >= 2) {
    // 切到第二个 tab
    await tabs.nth(1).click();
    await wait(SETTLE_TIME);
    const count1 = await countTranslations(page);
    console.log(`  切换到第二个 tab, 翻译块: ${count1}`);

    // 滚动几屏
    await scrollToBottom(page, 3);
    await wait(SETTLE_TIME);
    const count2 = await countTranslations(page);
    console.log(`  滚动后翻译块: ${count2}`);

    // 切回第一个 tab
    await tabs.nth(0).click();
    await wait(SETTLE_TIME);
    const count3 = await countTranslations(page);
    console.log(`  切回第一个 tab, 翻译块: ${count3}`);
  } else {
    console.log('  未找到足够的 tab，跳过');
  }
}

/** S9: 极速连续滚动（模拟用户快速浏览） */
async function s9_burstScroll(page: Page) {
  currentScenario = 'S9_burstScroll';
  console.log('\n=== S9: 爆发式滚动 (20 次小步快滚) ===');
  const before = await countTranslations(page);
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => window.scrollBy(0, 400));
    await wait(80);
  }
  await wait(SETTLE_TIME);
  const after = await countTranslations(page);
  console.log(`  翻译块: ${before} → ${after} (新增 ${after - before})`);
}

/** S10: 回到顶部 + 等待全部完成 */
async function s10_finalSweep(page: Page) {
  currentScenario = 'S10_finalSweep';
  console.log('\n=== S10: 最终回顶 + 统计 ===');
  await scrollToTop(page);
  await wait(SETTLE_TIME);
  const total = await countTranslations(page);
  const pending = await countPending(page);
  const fails = await page.locator('.dualang-status--fail').count();
  console.log(`  翻译块: ${total}, 待处理: ${pending}, 失败: ${fails}`);
}

// ============ 分析报告 ============
function printReport() {
  console.log('\n' + '='.repeat(70));
  console.log('                    DUALANG 压力测试报告');
  console.log('='.repeat(70));

  // 1. 按场景统计 API 请求
  console.log('\n📊 按场景统计 API 请求:');
  console.log('-'.repeat(60));
  const scenarioMap = new Map<string, typeof apiLog>();
  for (const entry of apiLog) {
    if (!scenarioMap.has(entry.scenario)) scenarioMap.set(entry.scenario, []);
    scenarioMap.get(entry.scenario)!.push(entry);
  }
  let totalRequests = 0;
  let totalErrors = 0;
  for (const [scenario, entries] of scenarioMap) {
    const errors = entries.filter(e => e.error);
    const successes = entries.filter(e => !e.error);
    const avgRtt = successes.length > 0 ? (successes.reduce((s, e) => s + e.rttMs, 0) / successes.length).toFixed(0) : '-';
    const totalTexts = successes.reduce((s, e) => s + e.subBatchSize, 0);
    console.log(`  ${scenario.padEnd(22)} 请求: ${entries.length.toString().padStart(3)}, 成功: ${successes.length.toString().padStart(3)}, 错误: ${errors.length.toString().padStart(2)}, 翻译条数: ${totalTexts.toString().padStart(3)}, 平均RTT: ${avgRtt}ms`);
    totalRequests += entries.length;
    totalErrors += errors.length;
  }
  console.log('-'.repeat(60));
  console.log(`  总计: ${totalRequests} 请求, ${totalErrors} 错误`);

  // 2. RTT 分布
  const rtts = apiLog.filter(e => !e.error).map(e => e.rttMs).sort((a, b) => a - b);
  if (rtts.length > 0) {
    console.log('\n⏱  RTT 分布 (ms):');
    console.log(`  min: ${rtts[0].toFixed(0)}`);
    console.log(`  p25: ${rtts[Math.floor(rtts.length * 0.25)].toFixed(0)}`);
    console.log(`  p50: ${rtts[Math.floor(rtts.length * 0.5)].toFixed(0)}`);
    console.log(`  p75: ${rtts[Math.floor(rtts.length * 0.75)].toFixed(0)}`);
    console.log(`  p95: ${rtts[Math.floor(rtts.length * 0.95)].toFixed(0)}`);
    console.log(`  max: ${rtts[rtts.length - 1].toFixed(0)}`);
    console.log(`  avg: ${(rtts.reduce((a, b) => a + b, 0) / rtts.length).toFixed(0)}`);
  }

  // 3. 关键 perf 事件统计
  console.log('\n🔍 关键事件统计:');
  const eventCounts = new Map<string, number>();
  for (const e of perfLog) {
    eventCounts.set(e.event, (eventCounts.get(e.event) || 0) + 1);
  }
  for (const [event, count] of [...eventCounts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${event.padEnd(25)} ${count}`);
  }

  // 4. Summary 事件中的计数器
  const summaries = perfLog.filter(e => e.event === 'summary');
  if (summaries.length > 0) {
    const last = summaries[summaries.length - 1].data;
    console.log('\n📈 最终 perfCounters:');
    for (const [k, v] of Object.entries(last)) {
      console.log(`  ${k.padEnd(28)} ${v}`);
    }
  }

  // 5. 缓存恢复统计
  const cacheRestores = perfLog.filter(e => e.event === 'scanAndQueue' && e.data.cacheRestored > 0);
  const totalRestored = cacheRestores.reduce((s, e) => s + (e.data.cacheRestored || 0), 0);
  console.log(`\n🗄  推文 ID 缓存恢复总次数: ${totalRestored}`);

  // 6. 错误详情
  const errors = apiLog.filter(e => e.error);
  if (errors.length > 0) {
    console.log('\n❌ 错误详情:');
    for (const e of errors) {
      console.log(`  [${e.scenario}] ${e.error}`);
    }
  }

  console.log('\n' + '='.repeat(70));
}

// ============ 主流程 ============
async function main() {
  console.log('连接浏览器 CDP...');
  const browser = await chromium.connectOverCDP(CDP_URL);
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    console.error('没有找到浏览器上下文');
    return;
  }

  const context = contexts[0];
  // 找到 X.com 页面
  let page: Page | null = null;
  for (const p of context.pages()) {
    const url = p.url();
    if (url.includes('x.com') || url.includes('twitter.com')) {
      page = p;
      break;
    }
  }

  if (!page) {
    console.error('没有找到 X.com 页面，请先打开 x.com');
    return;
  }

  console.log(`找到 X.com 页面: ${page.url()}`);
  attachLogger(page);

  // 确保在首页
  if (!page.url().includes('/home')) {
    await page.goto('https://x.com/home');
    await wait(3000);
  }

  const t0 = Date.now();

  // 执行 10 个场景
  await s1_initialLoad(page);
  await s2_slowScrollDown(page);
  await s3_rapidScroll(page);
  await s4_backToTop(page);
  await s5_showMore(page);
  await s6_deepScroll(page);
  await s7_backForward(page);
  await s8_tabSwitch(page);
  await s9_burstScroll(page);
  await s10_finalSweep(page);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n总耗时: ${elapsed}s`);

  // 等最后一轮 summary
  await wait(11000);

  printReport();

  // 不关闭浏览器 — 用户还在用
  await browser.close();  // 只断开 CDP 连接，不关浏览器
}

main().catch(console.error);
