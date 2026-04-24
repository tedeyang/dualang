// 翻译 pipeline 的纯函数组合件，由 index.ts 的 handleTranslateBatch 协调。
// 不持有状态：stats / cache / rateLimiter 作为依赖通过参数传入（便于单测 mock）。

import { cacheKey, setCache } from './cache';
import { doTranslateBatchRequest } from './api';
import { recordRequest, recordError } from './stats';
import { log } from '../shared/logger';
import type { Settings, TokenUsage, DictionaryEntry } from '../shared/types';

export type BatchApiResult = {
  translations: string[];
  /** 与 translations 对齐；combined call 返回，否则 undefined。*/
  dictEntries?: (DictionaryEntry[] | null)[];
  usage?: TokenUsage;
};

export type { Settings };

/**
 * 把主 settings 复写成 fallback 路径的 settings。
 * 历史上 raceMainAndFallback / handleTranslateBatch catch 分支 / handleSuperFineStream
 * 三处各自手写相同的 spread，改这三处常忘一处。
 */
export function buildFallbackSettings(settings: Settings): Settings {
  return {
    ...settings,
    apiKey: settings.fallbackApiKey || '',
    baseUrl: settings.fallbackBaseUrl || settings.baseUrl,
    model: settings.fallbackModel || settings.model,
    reasoningEffort: 'none',
  };
}

/**
 * 把一批翻译结果按 index 写入共享的 results 数组，并同步写 L2 缓存。
 * settings 决定缓存 key 的 model/baseUrl 维度；fallback 路径写入时传
 * fallbackSettings 让命中逻辑独立。
 */
export async function applyBatchResult(
  originalTexts: string[],
  toTranslateIndices: number[],
  apiResult: BatchApiResult,
  results: (string | null)[],
  settings: Settings,
  cacheModel: string,
  /**
   * 可选：combined call 下的字典输出缓冲区，长度与 originalTexts 对齐。
   * 只有 smartDictIndices 指定过的子集条目会被写入（三态：null / [] / [entries]）；
   * 未指定的条目保持 undefined，由上游 content 决定是否发独立字典 API fallback。
   */
  dictOut?: (DictionaryEntry[] | null | undefined)[],
  smartDictIndices?: Set<number>,
): Promise<void> {
  for (let i = 0; i < toTranslateIndices.length; i++) {
    const idx = toTranslateIndices[i];
    const translated = apiResult.translations[i];
    results[idx] = translated;
    // 仅对 smartDictIndices 指定过的子集索引写 dictOut —— 保留 undefined = "not attempted"
    if (dictOut && smartDictIndices?.has(i)) {
      dictOut[idx] = apiResult.dictEntries?.[i] ?? null;
    }
    const hash = cacheKey(originalTexts[idx], settings.targetLang, settings.model, settings.baseUrl);
    await setCache(hash, {
      text: originalTexts[idx],
      translated,
      lang: settings.targetLang,
      model: cacheModel,
      ts: Date.now(),
    });
  }
}

/**
 * 按 FB 兜底路径执行：打 badge、发一次请求、成败都记 stats、失败抛出。
 * 调用方负责：
 *   - 保证 fallbackConfigured（否则不该走这里）
 *   - 清 badge（在最外层 finally 里）
 */
export async function runFallback(
  texts: string[],
  settings: Settings,
  smartDictIndices?: Set<number>,
  perItemCandidates?: (string[] | null | undefined)[],
): Promise<{ apiResult: BatchApiResult; settings: Settings }> {
  const fbSettings = buildFallbackSettings(settings);
  chrome.action.setBadgeText({ text: 'FB' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#f7a800' }).catch(() => {});

  const t0 = performance.now();
  try {
    const apiResult = await doTranslateBatchRequest(texts, fbSettings, null, 3, false, { smartDictIndices, perItemCandidates });
    const rtt = performance.now() - t0;
    recordRequest(fbSettings.model, true, rtt, apiResult.usage).catch(() => {});
    log.info('translate.request.ok', {
      model: fbSettings.model, rttMs: Math.round(rtt),
      tokens: apiResult.usage?.total_tokens, via: 'fallback',
    });
    return { apiResult, settings: fbSettings };
  } catch (err: any) {
    const rtt = performance.now() - t0;
    recordRequest(fbSettings.model, false, rtt).catch(() => {});
    recordError(fbSettings.model, err.message || String(err)).catch(() => {});
    throw err;
  }
}

/** 兜底可用性判定：用户勾选 + 有 key 配置 */
export function isFallbackConfigured(settings: Settings): boolean {
  return !!settings.fallbackEnabled && !!settings.fallbackApiKey;
}

/**
 * 超级精翻的 settings 复写：基于主 settings，强制开流式并禁用 fallback/hedged
 * （精翻是长耗时的用户可见单次请求，不适合赛马；一旦主链失败直接报错更清晰）。
 * 可选 moonshot 覆写（opt-in）：baseUrl + 8k maxTokens + 专用 key。
 */
export function buildSuperFineSettings(
  baseSettings: Settings,
  moonshot?: { model: string; apiKey: string },
): Settings {
  const common: Settings = {
    ...baseSettings,
    enableStreaming: true,
    fallbackEnabled: false,
    hedgedRequestEnabled: false,
  };
  if (!moonshot) return common;
  return {
    ...common,
    baseUrl: 'https://api.moonshot.cn/v1',
    model: moonshot.model,
    apiKey: moonshot.apiKey,
    maxTokens: 8192,
    reasoningEffort: 'none',
  };
}

/** 赛马条件：非本地配置 hedged + 有 fallback + 用户可见的请求（priority ≥ 1） */
export function shouldHedge(settings: Settings, priority: number): boolean {
  return !!settings.hedgedRequestEnabled
    && isFallbackConfigured(settings)
    && priority >= 1;
}

/**
 * 估算 token：输入字符 + 每条 120 token JSON 结构开销，除以 2（EN→CJK 展开保守值）。
 * 与 api.ts 的 computeMaxTokens 保持同一比率；rate-limiter acquire 时要求的 tokenEstimate
 * 反映真实配额占用，避免长文 batch 被 limiter 误判能过关实际却触发 TPM。
 */
export function estimateTokens(texts: string[], maxTokens: number | string | undefined): number {
  const totalChars = texts.reduce((s, t) => s + t.length, 0);
  const mt = parseInt(String(maxTokens ?? ''), 10) || 4096;
  return Math.ceil((totalChars + mt * texts.length) / 2);
}
