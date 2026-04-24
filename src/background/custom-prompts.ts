/**
 * 自定义 system prompt 存储 + 缓存。
 *
 * 设计原则：**只暴露翻译指令，工程协议锁死**。
 *   工程协议（<tN> 标签 / ---DICT--- 分隔符 / JSON 输出格式）由 profiles 内部硬拼，
 *   用户改不了 —— 改了下游 parser 就崩。
 *   用户能改的是"想让模型怎么翻译"那部分（语气、专有名词处理、不省略等等）。
 *
 * 存 chrome.storage.local 而非 sync：sync 单 key 8KB 上限容易超；用户也没必要跨设备同步。
 * 模板占位符 `{{LANG}}` 在 compose 时被换成当前目标语言中文显示名（如"简体中文"）。
 *
 * 兼容性：旧版本曾暴露 6 段（含 single/batch/dict/annotateDict）；这些 key 在
 * storage 里如果还残留，读取时一律忽略（即 fallback 到默认）。
 */

export interface CustomPrompts {
  /**
   * 翻译规则 —— 同时影响单条 + 批量翻译请求。
   * 控制译文风格、专有名词处理、语气保留、原文已是目标语时怎么办。
   * 拼装时插入到 intro 与"输出格式协议"之间。
   */
  translationRules?: string;
  /** 严格模式前缀 —— 质量重试时追加 */
  strict?: string;
  /** 重译加强前缀 —— 点品牌 logo 触发 */
  boost?: string;
}

export const CUSTOM_PROMPTS_KEY = 'dualang_custom_prompts_v1';

let cache: CustomPrompts | null = null;
let listenerAttached = false;

function ensureListener() {
  if (listenerAttached) return;
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[CUSTOM_PROMPTS_KEY]) cache = null;
    });
    listenerAttached = true;
  } catch {
    // 单测环境没 chrome.storage；缓存也无意义
  }
}

/** 读取 customPrompts；缓存命中直接返回，chrome.storage.onChanged 会自动失效 */
export async function getCustomPrompts(): Promise<CustomPrompts> {
  if (cache) return cache;
  ensureListener();
  try {
    const got = await chrome.storage.local.get({ [CUSTOM_PROMPTS_KEY]: {} });
    const raw = (got[CUSTOM_PROMPTS_KEY] as Record<string, unknown>) || {};
    // 只取我们认识的 key —— 旧 single/batch/dict/annotateDict 残留一律丢
    cache = {};
    if (typeof raw.translationRules === 'string') cache.translationRules = raw.translationRules;
    if (typeof raw.strict === 'string') cache.strict = raw.strict;
    if (typeof raw.boost === 'string') cache.boost = raw.boost;
  } catch {
    cache = {};
  }
  return cache;
}

/** 保存；空串 / 未填的 key 被剔除（避免把"未改"也存成占位符） */
export async function saveCustomPrompts(next: CustomPrompts): Promise<void> {
  const clean: CustomPrompts = {};
  for (const key of Object.keys(next) as (keyof CustomPrompts)[]) {
    const v = next[key];
    if (typeof v === 'string' && v.trim()) clean[key] = v;
  }
  await chrome.storage.local.set({ [CUSTOM_PROMPTS_KEY]: clean });
  cache = clean;
}

/** `{{LANG}}` → 目标语言中文显示名（如"简体中文"）；纯函数便于单测 */
export function applyLangToken(template: string, lang: string): string {
  return template.replace(/\{\{LANG\}\}/g, lang);
}

/**
 * 用户可编辑的默认值。3 段：
 *  - translationRules：翻译规则（决定译文质量/风格的核心指令）
 *  - strict：严格模式前缀
 *  - boost：重译加强前缀
 *
 * 工程协议（<tN> / ---DICT--- / JSON schema 等）不在此处，由 profiles.ts 内部硬拼。
 */
export const DEFAULT_PROMPTS = {
  translationRules: `1. 输出必须完全是{{LANG}}；专有名词可音译或保留原样。
2. 如果原文已经是{{LANG}}，直接返回原文（保留段落结构）。
3. 保持原文的语气、风格（口语化、幽默、讽刺等）。`,

  strict: `【严格模式必须遵守】
1. 完整翻译原文每一句，严禁省略、合并、总结或概括。
2. 原文有 N 段（空行分隔）→ 译文必须 N 段，段与段之间保留空行。
3. 输出必须完全是{{LANG}}；不得整句保留原文英文。
4. 保留 URL / @用户名 / #话题词 的原样（不翻译这些 token）。

`,

  boost: `【重译请求】用户对上一次译文不满意，请用更精准、地道的{{LANG}}重新翻译。
1. 保持原文语义完整，不得删减或合并句子。
2. 避免机械直译；遇到固定搭配 / 专有说法，优先采用目标语自然的表达。
3. 若上下文已明确，允许在保留原意的前提下换用不同措辞，避免与上一版雷同。

`,
} as const;
