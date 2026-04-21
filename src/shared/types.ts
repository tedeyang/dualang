// ========== 翻译设置（chrome.storage.sync + config.json 的合并形态）==========
// 字段默认值在 background/settings.ts 的 getSettings 里；popup 里也是同一套。

export type ProviderType = 'openai';
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
  lineFusionEnabled?: boolean;
  smartDictEnabled?: boolean;
  fallbackEnabled?: boolean;
  fallbackBaseUrl?: string;
  fallbackApiKey?: string;
  fallbackModel?: string;
  hedgedRequestEnabled?: boolean;
  hedgedDelayMs?: HedgedDelayMode;
}

export type DisplayMode = 'append' | 'translation-only' | 'inline' | 'bilingual';

// ========== Content ↔ Background 消息契约 ==========

/**
 * 字典注释条目 —— 与 content/smart-dict.ts 的 DictEntry 同形。
 * level 用中国学生熟悉的考试分级（bench 实测 GLM-4-9B 在 32 词金标集上 96.88% 准确）：
 *   - cet6   六级
 *   - ielts  雅思
 *   - kaoyan 考研
 * cet4（四级及以下常见词）一律不收 —— 字典注释只服务高难词。
 */
export type DictionaryLevel = 'cet6' | 'ielts' | 'kaoyan';
export interface DictionaryEntry {
  term: string;
  ipa: string;
  gloss: string;
  level?: DictionaryLevel;
}

export interface TranslateBatchPayload {
  texts: string[];
  priority?: number;
  skipCache?: boolean;
  strictMode?: boolean;
  /** 融合字典调用开关：需配合 englishFlags 才会真正产生字典条目 */
  smartDict?: boolean;
  /**
   * 与 texts 对齐；true 表示该条是英文且需要字典。
   * combined 调用在 user message 里给对应 ===N=== 打 "(dict)" 记号，让模型输出
   * ---DICT--- 段落。content 已经做过语种识别，避免 background 重做。
   */
  englishFlags?: boolean[];
  /**
   * "试试手气"重译：用户对当前译文不满意，手动点击 logo 触发。
   * background 侧会上浮 temperature（+0.3，最高 0.9）并在 system prompt 前追加
   * "请更准确翻译"的强化提示；同时 skipCache + strictMode 均已为 true。
   */
  retranslateBoost?: boolean;
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
  /**
   * 与 translations 对齐的字典条目；三态语义用于避免 content fallback 的双重调用：
   *   undefined   → combined 没 attempt 过这个 item（缓存命中 / 非英文 / 本地预筛 0 hard）
   *                 → content 该发独立 annotateDictionary API
   *   null        → combined attempt 了但模型没输出 ---DICT--- 段
   *   []          → attempt 了，段存在但 0 条可解析条目
   *   [entries]   → 正常字典返回
   * content 只对 undefined 才发 fallback；其他都直接采用（可能空，但不再浪费一次 API）。
   */
  dictEntries?: (DictionaryEntry[] | null | undefined)[];
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
