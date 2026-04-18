/**
 * 实测脚本：CDP 接入已运行的 Chrome，测试 Dualang 翻译性能
 * 前提：Chrome 以 --remote-debugging-port=9222 启动，并已登录 X.com
 * 运行：npx tsx live-test.ts
 */

import { chromium } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const CDP_URL = 'http://localhost:9222';

interface PerfEvent {
  event: string;
  data: Record<string, any>;
  ts: number;
}

async function main() {
  console.log(`CDP 接入 ${CDP_URL}…`);

  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  if (!context) throw new Error('未找到浏览器 context');

  // 找到 X.com 页面
  let page = context.pages().find(p => p.url().includes('x.com'));
  if (!page) {
    console.log('未找到 x.com 页面，新建…');
    page = await context.newPage();
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
  } else {
    console.log('找到已有 x.com 页面:', page.url());
    // 重新加载以注入最新 content script（扩展更新后旧页面仍运行旧脚本）
    console.log('重新加载页面以注入最新 content script…');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('页面加载完成:', page.url());
  }

  // ── 采集 console ──
  const perfEvents: PerfEvent[] = [];
  const allLogs: string[] = [];

  page.on('console', async (msg) => {
    const text = msg.text();
    allLogs.push(`[${msg.type()}] ${text}`);

    if (!text.includes('[Dualang:perf]')) return;
    try {
      const args = await Promise.all(
        msg.args().map((a) => a.jsonValue().catch(() => null))
      );
      const event = args[1] as string;
      const data = (args[2] as Record<string, any>) || {};
      perfEvents.push({ event, data, ts: Date.now() });

      if (['apiSuccess', 'apiError', 'concurrentCap', 'summary'].includes(event)) {
        const short: Record<string, any> = {};
        if (data.subBatchSize       !== undefined) short.subBatchSize = data.subBatchSize;
        if (data.rttMs              !== undefined) short.rttMs        = data.rttMs;
        if (data.capped             !== undefined) short.capped       = data.capped;
        if (data.activeRequests      !== undefined) short.activeReqs   = data.activeRequests;
        if (data.translatingSetSize !== undefined) short.tsSize       = data.translatingSetSize;
        if (data.renderCalls        !== undefined) {
          short.renders  = data.renderCalls;
          short.apiCalls = data.apiCalls;
          short.avgRtt   = data.avgApiRttMs;
          short.tsSize   = data.translatingSetSize;
        }
        console.log(`  [${event}]`, JSON.stringify(short));
      }
    } catch (_) {}
  });

  page.on('pageerror', (err) => {
    if (!err.message.includes('ApiError'))
      console.error('PageError:', err.message);
  });

  await page.waitForTimeout(2000);

  // ── 滚动直到 100 条翻译或超时 ──
  console.log('开始滚动，目标：≥100 条帖子翻译…');
  const startTs = Date.now();
  const TIMEOUT_MS = 6 * 60 * 1000;
  let lastRenderCount = 0;
  let stuckRounds = 0;

  while (Date.now() - startTs < TIMEOUT_MS) {
    const translated = await page.$$eval('.dualang-translation', els => els.length).catch(() => 0);
    const renderCount = perfEvents.filter(e => e.event === 'render').length;
    const apiCount    = perfEvents.filter(e => e.event === 'apiSuccess').length;
    const capCount    = perfEvents.filter(e => e.event === 'concurrentCap').length;
    const elapsed     = ((Date.now() - startTs) / 1000).toFixed(0);

    console.log(`  ${elapsed}s | 译文:${translated} render:${renderCount} api:${apiCount} cap:${capCount} queue:${perfEvents.filter(e=>e.event==='enqueue').length}`);

    // X.com 虚拟 DOM 会卸载滚出视口的元素，用 render 事件计数代替 DOM 计数
    if (renderCount >= 100) {
      console.log('✅ 已达到 100 条 render 事件，停止滚动');
      break;
    }

    if (renderCount === lastRenderCount) {
      stuckRounds++;
      if (stuckRounds >= 15) {
        console.log('  ⚠️  超过 60s 无新翻译，停止滚动');
        break;
      }
    } else {
      stuckRounds = 0;
    }
    lastRenderCount = renderCount;

    // 随机化滚动距离和间隔，避免被 X.com 反自动滚动检测
    const scrollFactor = 1.5 + Math.random() * 2;
    await page.evaluate((f) => window.scrollBy(0, window.innerHeight * f), scrollFactor);
    const waitMs = 3000 + Math.floor(Math.random() * 2000);
    await page.waitForTimeout(waitMs);
  }

  // 等剩余请求落地
  console.log('等待剩余请求完成（10s）…');
  await page.waitForTimeout(10000);

  // ── 最终统计 ──
  const finalTranslated = await page.$$eval('.dualang-translation', els => els.length).catch(() => 0);
  const finalFail       = await page.$$eval('.dualang-status--fail', els => els.length).catch(() => 0);

  const apiOk   = perfEvents.filter(e => e.event === 'apiSuccess');
  const apiErr  = perfEvents.filter(e => e.event === 'apiError');
  const caps    = perfEvents.filter(e => e.event === 'concurrentCap');
  const flushes = perfEvents.filter(e => e.event === 'flushQueue');
  const renders = perfEvents.filter(e => e.event === 'render');

  const rtts = apiOk.map(e => parseFloat(e.data.rttMs || '0')).filter(v => v > 0).sort((a,b) => a-b);
  const cacheHits = rtts.filter(r => r < 5).length;
  const avg  = rtts.length ? rtts.reduce((a,b)=>a+b,0)/rtts.length : 0;
  const p50  = rtts[Math.floor(rtts.length*0.50)] ?? 0;
  const p90  = rtts[Math.floor(rtts.length*0.90)] ?? 0;
  const p99  = rtts[Math.floor(rtts.length*0.99)] ?? 0;

  const batchDist: Record<number,number> = {};
  for (const e of apiOk) {
    const s = e.data.subBatchSize || 1;
    batchDist[s] = (batchDist[s] || 0) + 1;
  }

  const consecCaps = caps.filter((e,i) =>
    i > 0 && e.data.activeRequests !== undefined &&
    e.data.activeRequests === caps[i-1]?.data?.activeRequests
  ).length;

  console.log('\n════════════════════════════════════');
  console.log('           实测结果汇总');
  console.log('════════════════════════════════════');
  console.log(`耗时:               ${((Date.now()-startTs)/1000).toFixed(0)}s`);
  console.log(`渲染译文:           ${finalTranslated} 条`);
  console.log(`失败图标:           ${finalFail} 条`);
  console.log('');
  console.log(`API 成功次数:       ${apiOk.length}`);
  console.log(`API 失败次数:       ${apiErr.length}`);
  console.log(`缓存命中 (<5ms):    ${cacheHits} / ${rtts.length} (${rtts.length ? (cacheHits*100/rtts.length).toFixed(0) : 0}%)`);
  console.log(`RTT avg/p50/p90/p99: ${avg.toFixed(0)}/${p50.toFixed(0)}/${p90.toFixed(0)}/${p99.toFixed(0)} ms`);
  console.log('');
  console.log('subBatchSize 分布:');
  for (const [k,v] of Object.entries(batchDist).sort()) {
    console.log(`  size=${k}: ${v} 次 (${apiOk.length ? (v*100/apiOk.length).toFixed(0) : 0}%)`);
  }
  console.log('');
  console.log(`flushQueue 总次数:   ${flushes.length}`);
  console.log(`concurrentCap 次数:  ${caps.length}`);
  if (flushes.length) console.log(`cap/flush 比:        ${(caps.length/flushes.length).toFixed(2)}`);
  console.log(`render 事件:         ${renders.length}`);
  console.log('');

  if (consecCaps > 5) {
    console.log(`⚠️  仍有 concurrentCap 忙循环迹象: ${consecCaps} 次连续相同 tsSize`);
  } else {
    console.log(`✅ concurrentCap 无忙循环 (连续重复=${consecCaps})`);
  }

  // API 错误摘要
  if (apiErr.length) {
    console.log('\nAPI 错误摘要:');
    const errMap: Record<string,number> = {};
    for (const e of apiErr) {
      const key = String(e.data.error || '').slice(0,80);
      errMap[key] = (errMap[key]||0)+1;
    }
    for (const [k,v] of Object.entries(errMap)) console.log(`  ${v}x ${k}`);
  }

  console.log('\n════════════════════════════════════\n');

  const logPath = path.resolve(__dirname, `../x.com-cdp-${Date.now()}.log`);
  fs.writeFileSync(logPath, allLogs.join('\n'));
  console.log(`完整日志: ${logPath}`);

  await browser.close();
}

main().catch(err => {
  console.error('脚本出错:', err.message);
  process.exit(1);
});
