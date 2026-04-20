// ========== 翻译设置（chrome.storage.sync + config.json 的合并形态）==========
// 字段默认值在 background/settings.ts 的 getSettings 里；popup 里也是同一套。

export type ProviderType = 'openai' | 'browser-native';
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';
export type HedgedDelayMode = 'auto' | number;

/**
 * Settings：chrome.storage.sync + config.json 合并后的形态。
 * 字段都是可选的 —— 实际访问处普遍用 `settings.xxx || fallback` 模式，
 * 强求完整 shape 会让测试和 partial-override 场景写起来很累。
 * 运行时 getSettings() 会提供默认值。
 */
export interface Settings {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  providerType?: ProviderType;
  enableStreaming?: boolean;
  maxTokens?: number | string;
  reasoningEffort?: ReasoningEffort | string;
  targetLang?: string;
  autoTranslate?: boolean;
  displayMode?: DisplayMode | null;
  bilingualMode?: boolean;   // legacy, migrated to displayMode
  fallbackEnabled?: boolean;
  fallbackBaseUrl?: string;
  fallbackApiKey?: string;
  fallbackModel?: string;
  hedgedRequestEnabled?: boolean;
  hedgedDelayMs?: HedgedDelayMode;
}

export type DisplayMode = 'append' | 'translation-only' | 'inline' | 'bilingual';

// ========== Content ↔ Background 消息契约 ==========

export interface TranslateBatchPayload {
  texts: string[];
  priority?: number;
  skipCache?: boolean;
  strictMode?: boolean;
}

export interface TranslateSinglePayload {
  text: string;
  priority?: number;
}

export type TranslatePayload = TranslateBatchPayload | TranslateSinglePayload;

export interface TranslateRequest {
  action: 'translate';
  payload: TranslatePayload;
}

export interface ToggleMessage {
  action: 'toggle';
  enabled: boolean;
}

export type RuntimeMessage = TranslateRequest | ToggleMessage;

export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** 批量翻译返回 — translations 长度与请求 texts 一致；null 位表示未翻译（流式模式下）*/
export interface TranslateBatchResult {
  translations: string[];
  usage?: TokenUsage;
  model?: string;
  baseUrl?: string;
  fromCache?: boolean;
}

export interface TranslateSingleResult {
  translated: string;
  fromCache?: boolean;
  usage?: TokenUsage;
  model?: string;
  baseUrl?: string;
}

/** `chrome.runtime.sendMessage` 响应的通用包裹 */
export interface TranslateResponse<T = TranslateBatchResult | TranslateSingleResult> {
  success: boolean;
  data?: T;
  error?: string;
  retryable?: boolean;
}

// ========== 共享工具 ==========

/** 规范化文本：压缩空白、换行，用于 cacheKey 和文本比对 */
export function normalizeText(text: string): string {
  return text
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
