#!/usr/bin/env node
/**
 * 连 9222 端口，观察 X.com 当前页的 [Dualang] 日志，重点关注 dict.* 族。
 * 不修改页面 / 设置；仅挂 console listener。60s 超时或收到 done 事件后退出并汇报。
 */

import playwright from '/Users/tedeyang/GitHub/dualang/e2e/node_modules/playwright/index.js';
const { chromium } = playwright;

const CDP_URL = 'http://localhost:9222';
const TIMEOUT_MS = 60_000;
const DUALANG_PREFIX = '[Dualang]';

const tally = {
  translateOk: 0,
  translateFail: 0,
  dictRequestOk: 0,
  dictRequestFail: 0,
  dictResponseOk: 0,
  dictResponseFail: 0,
  dictSkipNoCandidates: 0,
  combinedParseFail: 0,
  samples: { dictRequestOk: [], dictResponseOk: [], combinedParseFail: [] },
};

function classifyAndTally(msg) {
  if (msg.includes('translation.request.ok')) tally.translateOk++;
  if (msg.includes('translation.request.fail')) tally.translateFail++;
  if (msg.includes('dict.request.ok')) { tally.dictRequestOk++; if (tally.samples.dictRequestOk.length < 3) tally.samples.dictRequestOk.push(msg); }
  if (msg.includes('dict.request.fail')) tally.dictRequestFail++;
  if (msg.includes('dict.request.err')) tally.dictRequestFail++;
  if (msg.includes('dict.response.ok')) { tally.dictResponseOk++; if (tally.samples.dictResponseOk.length < 3) tally.samples.dictResponseOk.push(msg); }
  if (msg.includes('dict.response.fail')) tally.dictResponseFail++;
  if (msg.includes('dict.skip.noCandidates')) tally.dictSkipNoCandidates++;
  if (msg.includes('combined call parse failed')) { tally.combinedParseFail++; if (tally.samples.combinedParseFail.length < 2) tally.samples.combinedParseFail.push(msg); }
}

(async () => {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const contexts = browser.contexts();
  console.log(`[probe] connected, ${contexts.length} contexts`);

  // 找 X.com 和 SW
  let xTab = null;
  for (const ctx of contexts) {
    for (const page of ctx.pages()) {
      if (page.url().includes('x.com') && !page.url().includes('docs')) {
        xTab = page;
      }
    }
  }
  if (!xTab) {
    console.error('[probe] 没找到 X.com tab');
    process.exit(2);
  }
  console.log(`[probe] watching: ${xTab.url()}`);

  // SW 日志 —— dict.request.ok 在 background 发，连 service_worker target 才能看到
  // 同时可以在 SW 里读 chrome.storage.sync 拿到设置
  let swTarget = null;
  for (const ctx of contexts) {
    const sws = ctx.serviceWorkers();
    for (const sw of sws) {
      if (sw.url().includes('dualang') || sw.url().includes('background.js')) {
        swTarget = sw;
        break;
      }
    }
    if (swTarget) break;
  }
  if (!swTarget) {
    console.log('[probe] ⚠️  没找到 background SW；只监听 content 日志');
  } else {
    console.log(`[probe] attached to SW: ${swTarget.url()}`);
    // SW 里读设置
    try {
      const settings = await swTarget.evaluate(() =>
        new Promise((r) => chrome.storage.sync.get(
          ['enabled', 'smartDictEnabled', 'lineFusionEnabled', 'targetLang', 'displayMode', 'baseUrl', 'model'],
          r,
        )),
      );
      console.log('[probe] settings:', JSON.stringify(settings, null, 2));
      if (!settings.smartDictEnabled) {
        console.log('[probe] ⚠️  smartDict 未开启 —— 测试意义不大，但会继续观察 translate 日志');
      }
    } catch (e) {
      console.log('[probe] ⚠️  无法读 SW 设置:', e.message);
    }
    swTarget.on('console', (c) => {
      const msg = c.text();
      if (!msg.includes(DUALANG_PREFIX) && !msg.includes('combined call parse failed')) return;
      console.log(`  SW  ${msg}`);
      classifyAndTally(msg);
    });
  }

  // Content-script 日志 —— dict.response.ok / dict.skip.noCandidates 是 content 发的
  xTab.on('console', (c) => {
    const msg = c.text();
    if (!msg.includes(DUALANG_PREFIX)) return;
    console.log(`  CONTENT  ${msg}`);
    classifyAndTally(msg);
  });

  // 让它跑一段时间收集日志。如果页面上已经有推文，顺手滚一滚触发更多 translate。
  console.log('[probe] 开始收集日志；尝试滚动触发翻译');
  let lastScroll = Date.now();
  const scrollInterval = setInterval(async () => {
    try {
      await xTab.evaluate(() => window.scrollBy(0, 600));
      lastScroll = Date.now();
    } catch (_) {}
  }, 2000);

  const start = Date.now();
  await new Promise((r) => setTimeout(r, TIMEOUT_MS));
  clearInterval(scrollInterval);

  const elapsed = Math.round((Date.now() - start) / 1000);
  console.log(`\n========== 汇总（${elapsed}s）==========`);
  console.log(JSON.stringify(tally, null, 2));

  console.log('\n========== 诊断 ==========');
  if (tally.translateOk === 0) {
    console.log('❌ 这段时间内没见到 translate.request.ok —— 页面可能没新推文，或翻译已走 cache。');
  } else {
    console.log(`✅ ${tally.translateOk} 次翻译请求成功`);
  }
  if (tally.dictRequestOk === 0 && tally.dictResponseOk === 0 && tally.dictSkipNoCandidates === 0) {
    console.log('❌ 完全没有 dict 相关日志 —— 可能原因：');
    console.log('   • 所有英文推文的候选词在本地预筛后都为空（短/易推文）');
    console.log('   • 译文全部来自缓存（不触发新请求）');
    console.log('   • smartDict 消息通路有问题 —— 检查 content → background annotateDictionary');
  } else {
    console.log(`✅ dict 路径被触发：request.ok=${tally.dictRequestOk} response.ok=${tally.dictResponseOk} skip=${tally.dictSkipNoCandidates}`);
  }
  if (tally.combinedParseFail > 0) {
    console.log(`⚠️  combined call parse 失败 ${tally.combinedParseFail} 次（已熔断 / 回退）`);
    for (const s of tally.samples.combinedParseFail) console.log(`      ${s.slice(0, 240)}`);
  }

  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error('[probe] crash:', e);
  process.exit(1);
});
