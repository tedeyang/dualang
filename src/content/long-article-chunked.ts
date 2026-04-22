import { splitIntoParagraphs } from './utils';
import { LONG_CHUNK_TIMEOUT_MS, adaptiveTimeoutMs } from './constants';

/**
 * 长文专用路径：把 text 按 \n\n 切成 N 段，5 段一 chunk 串行送 API，
 * 全部完成后 join('\n\n') 作为单段译文返回。外部调用方看不出是分多次完成的。
 *
 * 串行：避免一次性占满 MAX_CONCURRENT 与 background rate limiter；
 *       保证整体稳定可控，每个 chunk 独立 abort 不连带其他 chunk。
 *
 * 通过 translate-stream port（不是 sendMessage）发起：
 *   - 超时 / 页面切走时调 port.disconnect()
 *   - background 的 handleTranslateStream 监听 onDisconnect → AbortController.abort()
 *     → 在途 fetch 立即取消，释放 rate-limiter 配额
 */

export interface LongChunkedResult {
  translations: string[];     // 长度永远为 1（join 后的整段译文）
  usage: { total_tokens: number };
  model?: string;
  baseUrl?: string;
  fromCache: false;
}

export async function requestTranslationChunked(
  text: string, priority: number, skipCache: boolean, strictMode: boolean,
  opts: { retranslateBoost?: boolean } = {},
): Promise<LongChunkedResult> {
  const paragraphs = splitIntoParagraphs(text);
  const translations: string[] = new Array(paragraphs.length).fill('');
  let totalTokens = 0;
  let meta: { model?: string; baseUrl?: string } = {};
  const chunkSize = 5;

  for (let i = 0; i < paragraphs.length; i += chunkSize) {
    const chunkTexts = paragraphs.slice(i, i + chunkSize);
    const chunkResult = await requestChunkViaPort(chunkTexts, priority, i, skipCache, strictMode, opts.retranslateBoost);
    for (let k = 0; k < chunkResult.translations.length; k++) {
      translations[i + k] = chunkResult.translations[k];
    }
    totalTokens += chunkResult.totalTokens;
    meta = { model: chunkResult.model, baseUrl: chunkResult.baseUrl };
  }
  return {
    translations: [translations.join('\n\n')],
    usage: { total_tokens: totalTokens },
    model: meta.model,
    baseUrl: meta.baseUrl,
    fromCache: false,
  };
}

interface ChunkResult {
  translations: string[];
  totalTokens: number;
  model?: string;
  baseUrl?: string;
}

function requestChunkViaPort(
  chunkTexts: string[], priority: number, chunkOffset: number,
  skipCache: boolean, strictMode: boolean, retranslateBoost = false,
): Promise<ChunkResult> {
  return new Promise<ChunkResult>((resolve, reject) => {
    const port = chrome.runtime.connect(undefined, { name: 'translate-stream' });
    const out: string[] = new Array(chunkTexts.length).fill('');
    let settled = false;
    let chunkModel: string | undefined;
    let chunkBaseUrl: string | undefined;

    // 按 chunk 字符量自适应超时：~4k 字符的 chunk 会拿 60s baseline；更长 chunk 线性扩展到 3 min。
    const chunkChars = chunkTexts.reduce((a, t) => a + t.length, 0);
    const chunkTimeoutMs = adaptiveTimeoutMs(chunkChars, LONG_CHUNK_TIMEOUT_MS);
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { port.disconnect(); } catch (_) {}
      reject(new Error(`长文 chunk @${chunkOffset} 翻译超时 (${Math.round(chunkTimeoutMs / 1000)}s)`));
    }, chunkTimeoutMs);

    port.onMessage.addListener((msg) => {
      if (settled) return;
      if (msg.action === 'partial') {
        if (typeof msg.index === 'number' && msg.index >= 0 && msg.index < out.length && msg.translated) {
          out[msg.index] = msg.translated;
          if (msg.model) chunkModel = msg.model;
          if (msg.baseUrl) chunkBaseUrl = msg.baseUrl;
        }
      } else if (msg.action === 'done') {
        settled = true;
        clearTimeout(timeout);
        // `done` 捎带一个完整 translations 数组 —— 覆写 partial 收集的结果以确保完整性
        const finalTranslations = Array.isArray(msg.translations)
          ? msg.translations.map((t: any, i: number) => t || out[i])
          : out;
        resolve({
          translations: finalTranslations,
          totalTokens: 0,  // translate-stream 不上报 usage（缓存命中也算 0）
          model: msg.model || chunkModel,
          baseUrl: msg.baseUrl || chunkBaseUrl,
        });
        try { port.disconnect(); } catch (_) {}
      } else if (msg.action === 'error') {
        settled = true;
        clearTimeout(timeout);
        const e: any = new Error(msg.error || `长文 chunk @${chunkOffset} 失败`);
        e.retryable = msg.retryable !== false;
        reject(e);
        try { port.disconnect(); } catch (_) {}
      }
    });

    port.onDisconnect.addListener(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`长文 chunk @${chunkOffset} 连接断开`));
    });

    port.postMessage({
      action: 'translate',
      payload: { texts: chunkTexts, priority, skipCache, strictMode, retranslateBoost },
    });
  });
}
