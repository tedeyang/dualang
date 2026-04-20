// background.js - 服务工作者（orchestrator）

import { getCache, getCacheBatch, setCache, cacheKey } from './cache';
import { getSettings, invalidateSettingsCache, getMoonshotKey } from './settings';
import { rateLimiter } from './rate-limiter';
import { doTranslateSingle, doTranslateBatchRequest, doTranslateBatchStream } from './api';
import { recordRequest, recordCacheHit, recordQualityRetry, recordError, getStats, resetStats } from './stats';
import {
  buildFallbackSettings, buildSuperFineSettings, applyBatchResult, runFallback,
  isFallbackConfigured, shouldHedge, estimateTokens,
} from './pipeline';
import type { Settings, TokenUsage } from '../shared/types';

// ===================== 设置缓存失效 =====================
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') invalidateSettingsCache();
});

// ===================== Keep-Alive =====================
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keepalive') {
    port.onDisconnect.addListener(() => {});
  } else if (port.name === 'translate-stream') {
    // 流式翻译端口：content 发送 payload，background 逐条推送结果
    port.onMessage.addListener((msg) => {
      if (msg.action === 'translate') {
        handleTranslateStream(msg.payload, port);
      }
    });
  } else if (port.name === 'super-fine') {
    // 超级精翻流式端口：长文按段切 chunk，Kimi k2.5 + SSE 逐段推送
    port.onMessage.addListener((msg) => {
      if (msg.action === 'translate') {
        handleSuperFineStream(msg.payload, port);
      }
    });
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('keepalive', { periodInMinutes: 1 });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('keepalive', { periodInMinutes: 1 });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'keepalive') return;
});

// ===================== 生命周期 & 菜单 =====================
chrome.runtime.onInstalled.addListener(() => {
  console.log('[Dualang] 扩展已安装');
  initContextMenu();
  chrome.storage.sync.get({ enabled: true }).then(({ enabled }) => {
    updateContextMenu(enabled);
  });
});

const MENU_ID = 'dualang-toggle';

function initContextMenu() {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Dualang: 开启',
    contexts: ['page'],
    documentUrlPatterns: ['https://x.com/*', 'https://twitter.com/*']
  });
}

function updateContextMenu(enabled: boolean) {
  chrome.contextMenus.update(MENU_ID, {
    title: enabled ? 'Dualang: 开启 (点击关闭)' : 'Dualang: 关闭 (点击开启)'
  }).catch(() => {});
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  const { enabled } = await chrome.storage.sync.get({ enabled: true });
  const next = !enabled;
  await chrome.storage.sync.set({ enabled: next });
  updateContextMenu(next);
  broadcastToXTabs({ action: 'toggle', enabled: next });
});

async function broadcastToXTabs(message: any) {
  const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id!, message).catch(() => {});
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && (tab.url.includes('x.com') || tab.url.includes('twitter.com'))) {
    chrome.storage.sync.get({ enabled: true }).then(({ enabled }) => {
      chrome.tabs.sendMessage(tabId, { action: 'toggle', enabled }).catch(() => {});
    });
  }
});

// ===================== 翻译服务 =====================

const inFlight = new Map();

// ===================== 主 API RTT 滚动统计（用于自适应赛马延迟）=====================
// 保留最近 N 次主 API 成功请求的 RTT（毫秒）。不跟踪失败请求 — 失败不代表"慢"。
const RTT_WINDOW = 20;
const HEDGE_FLOOR_MS = 300;   // 自适应延迟下限（太小的延迟等于即时并发）
const HEDGE_CEILING_MS = 3000; // 上限（即使主 API 非常慢也不会让用户等更久）
const HEDGE_BOOTSTRAP_MS = 500; // 样本不足时的保底延迟
const mainRttSamples: number[] = [];

function recordMainRtt(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return;
  mainRttSamples.push(ms);
  if (mainRttSamples.length > RTT_WINDOW) mainRttSamples.shift();
}

function getAdaptiveHedgeDelayMs(): number {
  if (mainRttSamples.length < 3) return HEDGE_BOOTSTRAP_MS;
  const sorted = [...mainRttSamples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  const p95 = sorted[idx];
  return Math.max(HEDGE_FLOOR_MS, Math.min(HEDGE_CEILING_MS, p95));
}

/** 把设置里的 hedgedDelayMs（'auto' | 数字）解析成实际毫秒 */
function resolveHedgeDelayMs(settings: Settings): number {
  const v = settings.hedgedDelayMs;
  if (v === 'auto' || v === undefined || v === null) return getAdaptiveHedgeDelayMs();
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) return HEDGE_BOOTSTRAP_MS;
  return n;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'translate') {
    handleTranslate(request.payload)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(err => sendResponse({ success: false, error: err.message, retryable: !!err.retryable }));
    return true;
  }
  if (request.action === 'getHedgeStats') {
    sendResponse({
      success: true,
      data: {
        samples: mainRttSamples.length,
        p95Ms: getAdaptiveHedgeDelayMs(),
        floorMs: HEDGE_FLOOR_MS,
        ceilingMs: HEDGE_CEILING_MS,
      },
    });
    return false;
  }
  if (request.action === 'getStats') {
    getStats().then(data => sendResponse({ success: true, data }));
    return true;
  }
  if (request.action === 'resetStats') {
    resetStats().then(() => sendResponse({ success: true }));
    return true;
  }
  if (request.action === 'recordQualityRetry') {
    // content script 质量重试时上报，让统计完整
    recordQualityRetry().then(() => sendResponse({ success: true }));
    return true;
  }
});

async function handleTranslate(payload: any) {
  const settings = await getSettings();
  console.log('[Dualang] translate config baseUrl=', settings.baseUrl, 'model=', settings.model, 'priority=', payload.priority);

  if (payload.texts && Array.isArray(payload.texts)) {
    return handleTranslateBatch(payload.texts, settings, payload.priority || 0, !!payload.skipCache, !!payload.strictMode);
  }

  // 单条模式（向后兼容）
  const hash = cacheKey(payload.text, settings.targetLang, settings.model, settings.baseUrl);
  if (!settings.enableStreaming) {
    const cached = await getCache(hash);
    if (cached) return { translated: cached.translated, fromCache: true };
  }
  if (inFlight.has(hash)) {
    const result = await inFlight.get(hash);
    return { translated: result.translated, fromCache: false };
  }

  const flightPromise = doTranslateSingle(payload.text, settings)
    .then(async (result) => {
      if (!settings.enableStreaming) {
        await setCache(hash, { text: payload.text, translated: result.translated, lang: settings.targetLang, model: settings.model, ts: Date.now() });
      }
      return result;
    })
    .finally(() => { inFlight.delete(hash); });

  inFlight.set(hash, flightPromise);
  const result = await flightPromise;
  return { translated: result.translated, fromCache: false };
}

// ===================== 流式翻译（port 推送）=====================

async function handleTranslateStream(payload: any, port: chrome.runtime.Port) {
  try {
    const settings = await getSettings();
    const texts: string[] = payload.texts;
    if (!texts || !Array.isArray(texts) || texts.length === 0) {
      port.postMessage({ action: 'done', translations: [] });
      return;
    }

    // skipCache=true（质量重试）时跳过缓存读，避免刚落盘的坏翻译把自己的重试吞掉
    const skipCache = !!payload.skipCache;
    const strictMode = !!payload.strictMode;
    const hashes = texts.map(t => cacheKey(t, settings.targetLang, settings.model, settings.baseUrl));
    const cachedEntries = skipCache ? new Array(texts.length).fill(null) : await getCacheBatch(hashes);

    const results = new Array(texts.length).fill(null);
    const toTranslateIndices: number[] = [];
    const toTranslateTexts: string[] = [];

    for (let i = 0; i < texts.length; i++) {
      if (cachedEntries[i]) {
        results[i] = cachedEntries[i].translated;
        // 缓存命中立即推送
        port.postMessage({ action: 'partial', index: i, translated: results[i], fromCache: true });
      } else {
        toTranslateIndices.push(i);
        toTranslateTexts.push(texts[i]);
      }
    }

    if (toTranslateTexts.length === 0) {
      port.postMessage({ action: 'done', translations: results });
      return;
    }

    const totalChars = toTranslateTexts.reduce((sum, t) => sum + t.length, 0);
    const maxTokens = parseInt(settings.maxTokens, 10) || 4096;
    const tokenEstimate = Math.ceil((totalChars + maxTokens * toTranslateTexts.length) / 3);
    const priority = payload.priority || 0;
    const registerTask = await rateLimiter.acquire(tokenEstimate, priority);

    const abortController = new AbortController();
    const release = registerTask(priority, () => abortController.abort());

    // port 断开时中止请求
    let disconnected = false;
    port.onDisconnect.addListener(() => {
      disconnected = true;
      abortController.abort();
    });

    try {
      const apiResult = await doTranslateBatchStream(
        toTranslateTexts,
        settings,
        abortController.signal,
        (subIndex, translated) => {
          if (disconnected) return;
          const originalIndex = toTranslateIndices[subIndex];
          results[originalIndex] = translated;
          port.postMessage({
            action: 'partial', index: originalIndex, translated,
            model: settings.model, baseUrl: settings.baseUrl,
          });
          // 写缓存
          const hash = cacheKey(texts[originalIndex], settings.targetLang, settings.model, settings.baseUrl);
          setCache(hash, { text: texts[originalIndex], translated, lang: settings.targetLang, model: settings.model, ts: Date.now() }).catch(() => {});
        },
        strictMode,
      );

      // 补全流式未推送的条目
      for (let i = 0; i < toTranslateIndices.length; i++) {
        const idx = toTranslateIndices[i];
        if (results[idx] === null && apiResult.translations[i]) {
          results[idx] = apiResult.translations[i];
          if (!disconnected) {
            port.postMessage({
              action: 'partial', index: idx, translated: results[idx],
              model: settings.model, baseUrl: settings.baseUrl,
            });
          }
        }
      }

      if (!disconnected) {
        port.postMessage({
          action: 'done', translations: results,
          model: settings.model, baseUrl: settings.baseUrl,
        });
      }
    } finally {
      release();
    }
  } catch (err: any) {
    try {
      port.postMessage({ action: 'error', error: err.message, retryable: !!err.retryable });
    } catch (_) {}
  }
}

// ===================== 超级精翻流式 =====================
// 长文按段切 chunk，Kimi k2.5 + SSE 逐段推送。协议：
//   content → background: { action:'translate', payload:{ text, targetLang } }
//   background → content: { action:'meta', paragraphs:N, chunks:N, model, baseUrl }
//   background → content: { action:'partial', index, translated }    — 每个段落完成立推
//   background → content: { action:'progress', completed, total }    — 每 chunk 完成后
//   background → content: { action:'done', totalTokens, model, baseUrl }
//   background → content: { action:'error', error }
async function handleSuperFineStream(payload: any, port: chrome.runtime.Port) {
  const CHUNK = 5;
  let disconnected = false;
  port.onDisconnect.addListener(() => { disconnected = true; });
  const abortController = new AbortController();
  port.onDisconnect.addListener(() => abortController.abort());

  try {
    const baseSettings = await getSettings();
    // 精翻 provider 选择：默认复用主设置（SiliconFlow GLM-4-9B-0414）——
    // 实测 TPM 充足 + 免费 + UTF-8 flush 已修，批量 chunked 稳定。
    // Moonshot Kimi 为 opt-in：payload.model 以 `moonshot-` 或 `kimi-` 开头时切换。
    const wantsMoonshot = typeof payload.model === 'string' &&
      (payload.model.startsWith('moonshot-') || payload.model.startsWith('kimi-'));

    let settings: Settings;  // filled by one of the two branches below
    if (wantsMoonshot) {
      const moonshotKey = await getMoonshotKey();
      if (!moonshotKey) {
        throw new Error('Moonshot 模型需要 API Key；请在 config.json 的 providers.moonshot.apiKey 填入，或不指定 model 以使用默认 GLM');
      }
      settings = buildSuperFineSettings(baseSettings, { model: payload.model, apiKey: moonshotKey });
    } else {
      if (!baseSettings.apiKey) {
        throw new Error('精翻需要 API Key；请在 popup 设置或 config.json 填入 SiliconFlow key');
      }
      settings = buildSuperFineSettings(baseSettings);
    }

    // content 端已经用 extractParagraphsByBlock 按 DOM block 结构切好段落
    // 直接接收数组，避免再做字符级拆分（容易因为 \n vs \n\n 差异出错）
    const paragraphs: string[] = Array.isArray(payload.paragraphs) ? payload.paragraphs : [];
    if (paragraphs.length === 0) {
      port.postMessage({ action: 'error', error: '无可翻译内容' });
      return;
    }

    const totalChunks = Math.ceil(paragraphs.length / CHUNK);
    port.postMessage({
      action: 'meta',
      paragraphs: paragraphs.length,
      chunks: totalChunks,
      model: settings.model,
      baseUrl: settings.baseUrl,
    });
    const totalChars = paragraphs.reduce((s, p) => s + p.length, 0);
    console.log('[Dualang] super-fine stream start', {
      paragraphs: paragraphs.length, chunks: totalChunks, chars: totalChars,
    });

    let totalTokens = 0;
    let completedParagraphs = 0;

    // 串行处理 chunks：Kimi k2.5 reasoning 模型单 chunk 就比较慢，再并发容易打爆
    // rate limit。串行 + SSE 流式组合保证"第一段就能开始读"的渐进体验。
    for (let ci = 0; ci < totalChunks; ci++) {
      if (disconnected || abortController.signal.aborted) return;
      const start = ci * CHUNK;
      const chunk = paragraphs.slice(start, start + CHUNK);
      try {
        const pushedIndices = new Set<number>();
        await doTranslateBatchStream(
          chunk,
          settings,
          abortController.signal,
          (subIndex, translated) => {
            if (disconnected) return;
            const globalIndex = start + subIndex;
            pushedIndices.add(subIndex);
            port.postMessage({ action: 'partial', index: globalIndex, translated });
            completedParagraphs++;
          },
          true, // strictMode：提示保留段落结构，减少模型压缩
        ).then((result) => {
          // 补推流式未覆盖的条目（通常是最后一条）
          for (let i = 0; i < result.translations.length; i++) {
            if (pushedIndices.has(i)) continue;
            const t = result.translations[i];
            if (!t) continue;
            const globalIndex = start + i;
            if (!disconnected) {
              port.postMessage({ action: 'partial', index: globalIndex, translated: t });
              completedParagraphs++;
            }
          }
        });
        if (!disconnected) {
          port.postMessage({ action: 'progress', completed: Math.min(start + chunk.length, paragraphs.length), total: paragraphs.length });
        }
      } catch (err: any) {
        console.warn('[Dualang] super-fine chunk fail', { chunkIndex: ci, error: err.message });
        // 单 chunk 失败不中止整体，继续下一个
        if (!disconnected) {
          port.postMessage({ action: 'chunkFail', chunkIndex: ci, error: err.message });
        }
      }
    }

    if (!disconnected) {
      port.postMessage({
        action: 'done',
        totalTokens,
        model: settings.model,
        baseUrl: settings.baseUrl,
        completed: completedParagraphs,
        total: paragraphs.length,
      });
    }
  } catch (err: any) {
    if (!disconnected) {
      try { port.postMessage({ action: 'error', error: err.message }); } catch (_) {}
    }
  }
}

// 延迟式赛马（hedged request）：
//   - 立刻发起主 API 请求
//   - 等待 hedgeDelayMs 毫秒：若此时主已成功/失败，则无需启动兜底（节省兜底配额）
//   - 超时仍未返回，再发起兜底；两路结果谁先成功用谁，败者 abort
// hedgeDelayMs：
//   - 'auto' → 主 API 最近 RTT 的 p95（夹在 300-3000ms 之间），样本不足时 500ms 保底
//   - 0     → 同时发起（经典赛马）
//   - N     → 固定 Nms
async function raceMainAndFallback(
  texts: string[],
  settings: Settings,
  outerSignal: AbortSignal,
  strictMode = false,
): Promise<{ translations: string[]; usage?: TokenUsage; winnerModel: string; winnerBaseUrl: string }> {
  const hedgeDelayMs = resolveHedgeDelayMs(settings);

  const mainAbort = new AbortController();
  const fbAbort = new AbortController();
  const onOuterAbort = () => { mainAbort.abort(); fbAbort.abort(); };
  if (outerSignal.aborted) onOuterAbort();
  else outerSignal.addEventListener('abort', onOuterAbort, { once: true });

  const fallbackSettings = buildFallbackSettings(settings);

  let mainErr: any = null;
  let fbErr: any = null;
  let mainSettled = false;

  const mainT0 = performance.now();
  const mainP = doTranslateBatchRequest(texts, settings, mainAbort.signal, 3, strictMode)
    .then(r => {
      mainSettled = true;
      recordMainRtt(performance.now() - mainT0);
      return r;
    })
    .catch(e => { mainSettled = true; mainErr = e; throw e; });

  // 兜底启动规则：
  //   1) 延迟到期时，若主还未返回 → 启动兜底（真正的 hedged request 语义）
  //   2) 主在延迟期内失败 → 立刻启动兜底，不再等 — "fallback" 语义优先于"赛跑"语义
  //   3) 主在延迟期内成功 → 兜底永不启动（节省配额）；fbP 会保持 pending，
  //      但 Promise.any 已用主的结果 resolve，不会挂起
  const fbP = new Promise<{ translations: string[]; usage?: TokenUsage }>((resolve, reject) => {
    let fbFired = false;
    const fireFallback = () => {
      if (fbFired) return;
      fbFired = true;
      doTranslateBatchRequest(texts, fallbackSettings, fbAbort.signal, 3, strictMode)
        .then(resolve)
        .catch(e => { fbErr = e; reject(e); });
    };
    const t = setTimeout(() => { if (!mainSettled) fireFallback(); }, hedgeDelayMs);
    // 主失败触发立即兜底
    mainP.catch(() => { clearTimeout(t); fireFallback(); });
    // 外层 abort 清定时器
    const cleanup = () => clearTimeout(t);
    if (outerSignal.aborted) cleanup();
    else outerSignal.addEventListener('abort', cleanup, { once: true });
  });

  try {
    const winner = await Promise.any([
      mainP.then(r => ({ src: 'main' as const, result: r })),
      fbP.then(r => ({ src: 'fallback' as const, result: r }))
    ]);
    if (winner.src === 'main') fbAbort.abort();
    else mainAbort.abort();
    console.log('[Dualang] hedged.winner', {
      src: winner.src, delayMs: hedgeDelayMs, count: texts.length,
    });
    const useSettings = winner.src === 'main' ? settings : fallbackSettings;
    return {
      translations: winner.result.translations,
      usage: winner.result.usage,
      winnerModel: useSettings.model,
      winnerBaseUrl: useSettings.baseUrl,
    };
  } catch (_aggErr) {
    // 两路都失败：优先抛主 API 的错（错误分类与 UI 对齐）
    throw mainErr || fbErr || new Error('hedged 请求全部失败');
  } finally {
    outerSignal.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * 从 texts 批量提取缓存命中 + 待翻译子集。返回 results 已预填命中条目、
 * 缺失索引数组用于后续 API 调用的 sub-batch 构造。
 */
async function batchCacheRead(texts: string[], settings: Settings, skipCache: boolean) {
  const hashes = texts.map(t => cacheKey(t, settings.targetLang, settings.model, settings.baseUrl));
  const cachedEntries = skipCache ? new Array(texts.length).fill(null) : await getCacheBatch(hashes);

  const results: (string | null)[] = new Array(texts.length).fill(null);
  const toTranslateIndices: number[] = [];
  const toTranslateTexts: string[] = [];

  for (let i = 0; i < texts.length; i++) {
    if (cachedEntries[i]) {
      results[i] = cachedEntries[i].translated;
    } else {
      toTranslateIndices.push(i);
      toTranslateTexts.push(texts[i]);
    }
  }
  return { results, toTranslateIndices, toTranslateTexts };
}

/**
 * 主 API 请求（含 RTT 采样）；shouldHedge 时走赛马路径。
 * 返回统一形状 { translations, usage, winnerModel, winnerBaseUrl }。
 */
async function executeMain(
  toTranslateTexts: string[],
  settings: Settings,
  abortSignal: AbortSignal,
  strictMode: boolean,
  priority: number,
) {
  const hedged = shouldHedge(settings, priority);
  const mainMaxRetries = (isFallbackConfigured(settings) && !hedged) ? 0 : 3;
  const mainT0 = performance.now();

  if (hedged) {
    return raceMainAndFallback(toTranslateTexts, settings, abortSignal, strictMode);
  }
  const r = await doTranslateBatchRequest(toTranslateTexts, settings, abortSignal, mainMaxRetries, strictMode);
  recordMainRtt(performance.now() - mainT0);
  return r;
}

async function handleTranslateBatch(texts: string[], settings: Settings, priority = 0, skipCache = false, strictMode = false) {
  const { results, toTranslateIndices, toTranslateTexts } = await batchCacheRead(texts, settings, skipCache);

  // 全命中：不占 rate limiter、不做 in-flight 登记
  if (toTranslateTexts.length === 0) {
    recordCacheHit(texts.length).catch(() => {});
    console.log('[Dualang] cache.hit.full', { count: texts.length, model: settings.model });
    return { translations: results, model: settings.model, baseUrl: settings.baseUrl, fromCache: true };
  }
  if (toTranslateTexts.length < texts.length) {
    recordCacheHit(texts.length - toTranslateTexts.length).catch(() => {});
  }

  // in-flight 去重：同一批 texts 并发请求共享一个 promise
  const batchHash = cacheKey(toTranslateTexts.join('\n---BATCH---\n'), settings.targetLang, settings.model, settings.baseUrl);
  if (inFlight.has(batchHash)) {
    const apiResult = await inFlight.get(batchHash);
    for (let i = 0; i < toTranslateIndices.length; i++) {
      results[toTranslateIndices[i]] = apiResult.translations[i];
    }
    return {
      translations: results,
      usage: apiResult.usage,
      model: apiResult.model || settings.model,
      baseUrl: apiResult.baseUrl || settings.baseUrl,
      fromCache: false,
    };
  }

  const registerTask = await rateLimiter.acquire(
    estimateTokens(toTranslateTexts, settings.maxTokens),
    priority,
  );
  const abortController = new AbortController();
  const release = registerTask(priority, () => abortController.abort());
  const startedAt = performance.now();

  const flightPromise = executeMain(toTranslateTexts, settings, abortController.signal, strictMode, priority)
    .then(async (apiResult: any) => {
      const rtt = performance.now() - startedAt;
      const usedModel = apiResult.winnerModel || settings.model;
      const usedBaseUrl = apiResult.winnerBaseUrl || settings.baseUrl;
      recordRequest(usedModel, true, rtt, apiResult.usage).catch(() => {});
      console.log('[Dualang] translation.request.ok', {
        model: usedModel, rttMs: Math.round(rtt), tokens: apiResult.usage?.total_tokens, count: toTranslateTexts.length,
      });
      await applyBatchResult(texts, toTranslateIndices, apiResult, results, settings, usedModel);
      return {
        translations: results, usage: apiResult.usage,
        model: usedModel, baseUrl: usedBaseUrl, fromCache: false,
      };
    })
    .catch(async (err: any) => {
      const rtt = performance.now() - startedAt;
      if (err.name === 'AbortError') {
        const e: any = new Error('请求被高优先级任务抢占，稍后重试');
        e.preempted = true;
        throw e;
      }
      recordRequest(settings.model, false, rtt).catch(() => {});
      recordError(settings.model, err.message || String(err)).catch(() => {});
      console.warn('[Dualang] translation.request.fail', {
        model: settings.model, rttMs: Math.round(rtt), error: err.message, retryable: err.retryable,
      });
      // hedged 模式下主+兜底已并发尝试过；非 hedged 且 fallback 已配置 → 立刻切换
      // （不在主上浪费 3 次指数退避 ≈ 14s 的等待）
      if (shouldHedge(settings, priority) || !isFallbackConfigured(settings)) throw err;

      console.log('[Dualang] fallback.activated', {
        reason: err.message, retryable: !!err.retryable, to: settings.fallbackModel,
      });
      const { apiResult, settings: fbSettings } = await runFallback(toTranslateTexts, settings);
      await applyBatchResult(texts, toTranslateIndices, apiResult, results, fbSettings, fbSettings.model);
      return {
        translations: results, usage: apiResult.usage,
        model: fbSettings.model, baseUrl: fbSettings.baseUrl, fromCache: false,
      };
    })
    .finally(() => {
      release();
      inFlight.delete(batchHash);
    });

  inFlight.set(batchHash, flightPromise);
  return await flightPromise;
}
