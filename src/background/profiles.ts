// Provider profile registry
//
// 集中描述每个模型提供方的调用参数：endpoint 路径、温度、思考模式控制字段、
// streaming 支持、system prompt 模板。新增模型只需加一个 profile 条目，
// 无需改 api.ts 的 body 构造逻辑。
//
// Profile 的匹配顺序：第一个命中的生效；`matchBaseUrl`（substring）和
// `matchModel`（regex）任一命中即算。都不命中则回落到 GENERIC_PROFILE。

// BCP-47 语言代码 → prompt 里拼中文的显示名。
// 放在这里（而不是 settings.ts）是因为它只被 prompt 拼装消费。
export const LANG_DISPLAY: Record<string, string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁体中文（台湾正体）',
  'en':    '英语',
  'ja':    '日语',
  'ko':    '韩语',
  'fr':    '法语',
  'de':    '德语',
  'es':    '西班牙语',
  'ru':    '俄语',
  'pt':    '葡萄牙语',
};

export type ThinkingControl =
  | 'omit'                      // 省略 reasoning_effort 即关闭（Moonshot / OpenAI 等）
  | 'enable-thinking-false'     // body.enable_thinking = false（Qwen 系列）
  | 'thinking-disabled';        // body.thinking = { type: 'disabled' }（GLM-4.6+）

export type ProviderProfile = {
  id: string;
  matchBaseUrl?: string;        // substring 匹配 settings.baseUrl（小写）
  matchModel?: RegExp;          // 匹配 settings.model
  endpointPath: string;         // 拼在 baseUrl 之后，默认 '/chat/completions'
  temperature: (settings: { model?: string }) => number;
  thinkingControl: ThinkingControl;
  supportsStreaming: boolean;
  systemPromptSingle: (langDisplay: string) => string;
  systemPromptBatch: (langDisplay: string) => string;
};

// ========== 共享 prompt 模板 ==========
// 设计原则：
//   - 单条翻译 → 纯文本输出（零结构）
//   - 多条批量 → ===N=== 分隔符（替代 JSON，小模型 7-9B 级处理 JSON 语法会崩）
//   - 严格模式 → 通用前缀，可拼到任意 prompt 前
// 历史教训：JSON 示例里的中文占位符（如"第一条翻译"）会被 7-9B 小模型当 template 照抄；
// JSON 字符串里的 \\n\\n 段落编码也经常被模型忽略。改分隔符后两个问题一起消失。

const SINGLE_PROMPT = (lang: string) => `请将用户提供的文本翻译成${lang}。

规则：
1. 输出必须完全是${lang}；专有名词可音译或保留原样。
2. 如果原文已经是${lang}，直接返回原文（保留段落结构）。
3. 只输出翻译结果，不要前缀（如"翻译："）、不要解释、不要 markdown 代码块。
4. 保留原文的段落结构（段落之间用空行分隔）。
5. 保持原文的语气、风格（口语化、幽默、讽刺等）。`;

const BATCH_PROMPT = (lang: string) => `请将以下多条推文分别翻译成${lang}。
每条推文在输入中用 "===N===" 标记（N 是从 0 起的索引）。

输出格式（严格遵守）：
按相同的 "===N===" 格式输出对应译文，N 与输入对齐。译文里的段落分隔直接用真实空行保留，不需要任何特殊编码。

规则：
1. 按 "===N===" 分隔符输出，index 与输入一一对应。
2. 译文中的段落分隔用真实空行保留；不要用 \\n\\n 字面串，也不要 JSON 转义。
3. 输出必须完全是${lang}；专有名词可保留原样。
4. 只输出带分隔符的纯文本；不要 JSON、不要 markdown 代码块、不要解释。
5. 如果某条原文已是${lang}，按原文返回（含段落结构）。

输出模板（占位符不可照抄，仅示意结构）：
===0===
<TRANSLATION_0>

===1===
<TRANSLATION_1>`;

// 严格前缀 —— 拼在单条或批量 prompt 前，用于质量重试场景。
// 显式禁止总结、强调段落保留；行为独立于输出格式（分隔符 or 纯文本）。
const STRICT_PREFIX = (lang: string) => `【严格模式必须遵守】
1. 完整翻译原文每一句，严禁省略、合并、总结或概括。
2. 原文有 N 段（空行分隔）→ 译文必须 N 段，段与段之间保留空行。
3. 输出必须完全是${lang}；不得整句保留原文英文。
4. 保留 URL / @用户名 / #话题词 的原样（不翻译这些 token）。

`;

// Combined call（翻译 + 字典融合）：仅在 batch 里追加。user message 会给需要字典的
// 条目在 "===N===" 后加 "(dict: word1 word2 ...)" 形式的候选词；模型按 ---DICT--- 段输出。
//
// level 用中国学生熟悉的考试分级（详见 docs/superpowers/reports/2026-04-20-glm-mixed-request-benchmark.md）：
// GLM-4-9B 在 32 词金标集上 cet4/cet6/ielts/kaoyan 四分类 96.88% 准确。
// 候选词已经在插件端用 Zipf + 音节 + 词长 本地预筛 —— 模型只需给 IPA / 释义 / level。
const BATCH_DICT_SUFFIX = (lang: string) => `

【字典融合】
输入中标注 "===N=== (dict: w1 w2 w3)" 的条目需在译文后追加字典块；未标注的条目不要加字典块。
括号里的词是预筛过的高难候选，字典条目只能从这些候选里选。

字典块格式（四段式，竖线分隔）：

===N=== (dict: w1 w2 w3)
<译文>
---DICT---
原词|/IPA/|${lang}释义|level
原词2|/IPA/|${lang}释义|level

字典规则：
1. 条目必须来自候选列表；候选外的词一律不要注释。
2. level 从 {cet6, ielts, kaoyan} 选 —— 分别对应六级 / 雅思 / 考研。
3. IPA 写国际音标，两头用斜线包裹；释义用${lang}，简短（≤8 字），不要整句解释。
4. 若候选列表为空或确实都不需要注释，直接省略 ---DICT--- 段，不要写空段。
5. 无 "(dict: ...)" 标记的条目一律不输出 ---DICT--- 段；多写会让解析失败。`;

/** 根据 profile + 是否批量 + 是否严格模式 + 是否字典融合，组装最终的 system prompt */
export function composeSystemPrompt(
  profile: ProviderProfile,
  lang: string,
  opts: { batch: boolean; strict: boolean; smartDict?: boolean },
): string {
  const base = opts.batch ? profile.systemPromptBatch(lang) : profile.systemPromptSingle(lang);
  const dictSuffix = opts.batch && opts.smartDict ? BATCH_DICT_SUFFIX(lang) : '';
  return (opts.strict ? STRICT_PREFIX(lang) : '') + base + dictSuffix;
}

import type { DictionaryEntry } from '../shared/types';

/**
 * 构造 batch 的 user message。每条前缀 "===N==="；当该 index 在 smartDictIndices 里，
 * 若 perItemCandidates 为对应 index 提供了词列表，则附加 "(dict: w1 w2 w3)" 指示模型。
 * 候选为空的索引不加 "(dict)" 标记 —— 模型不会误输出空 ---DICT--- 段。
 */
export function buildBatchUserContent(
  texts: string[],
  smartDictIndices?: Set<number>,
  perItemCandidates?: (string[] | null | undefined)[],
): string {
  return texts
    .map((t, i) => {
      let mark = '';
      if (smartDictIndices && smartDictIndices.has(i)) {
        const candidates = perItemCandidates?.[i];
        if (candidates && candidates.length > 0) {
          mark = ` (dict: ${candidates.join(' ')})`;
        }
      }
      return `===${i}===${mark}\n${t}`;
    })
    .join('\n\n');
}

/**
 * 解析 combined 响应：同时抽取译文 + 字典。
 * 每个 "===N===" chunk 内可能带 "---DICT---" 分隔；前段是译文，后段是每行一条的字典。
 *
 * 容错策略（GLM-4-9B 等小模型在多条 batch 下会偶发输出退化）：
 *   - "===N===" 的结尾 === 允许缺失：`===1 (dict)` 也当 index=1 处理
 *   - "(dict)" 记号可以有可以无、位置灵活
 *   - "---DICT---" 分隔线允许 ≥ 2 连字号且大小写宽松
 *   - 解析完全失败（0 条 hit）时回落到老的 parseDelimitedBatch（可能命中 JSON 回退）
 */
export function parseDelimitedBatchWithDict(
  raw: string,
  expectedCount: number,
): { translations: string[]; dictEntries: (DictionaryEntry[] | null)[] } {
  const translations = new Array<string>(expectedCount).fill('');
  const dictEntries = new Array<DictionaryEntry[] | null>(expectedCount).fill(null);

  // 宽松头部匹配：`={2,}` 开头、捕获 digit、允许任意 "(dict)" / 残缺 `===` 后缀
  const parts = raw.split(/^={2,}\s*(\d+)\s*(?:={2,})?[^\n]*\n?/m);
  let anyHit = false;
  for (let i = 1; i < parts.length - 1; i += 2) {
    const idx = parseInt(parts[i], 10);
    if (!Number.isFinite(idx) || idx < 0 || idx >= expectedCount) continue;
    const chunk = parts[i + 1] || '';

    // DICT 分隔：前后至少 2 个连字号 + "DICT"（大小写宽松）
    const dictSplit = chunk.split(/\n\s*-{2,}\s*DICT\s*-{2,}\s*\n?/i);
    translations[idx] = (dictSplit[0] || '').replace(/\n{3,}$/, '').trim();
    anyHit = true;

    if (dictSplit.length > 1) {
      const entries = parseDictLines(dictSplit.slice(1).join('\n'));
      if (entries.length > 0) dictEntries[idx] = entries;
    }
  }
  if (anyHit) return { translations, dictEntries };

  // 回落：走老的非字典 JSON/分隔符解析（dictEntries 保持全 null）
  return { translations: parseDelimitedBatch(raw, expectedCount), dictEntries };
}

function parseDictLines(body: string): DictionaryEntry[] {
  const out: DictionaryEntry[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // 允许起始 bullet / 数字等噪声："- amazing | /ipa/ | 惊艳 | ielts" → 照常拆
    const cleaned = line.replace(/^[\s\-*•·]+/, '');
    const parts = cleaned.split('|').map((s) => s.trim());
    if (parts.length < 2) continue;
    const [term, ipa = '', gloss = '', levelRaw = ''] = parts;
    if (!term) continue;
    if (!ipa && !gloss) continue;
    const level = normalizeDictLevel(levelRaw);
    out.push(level ? { term, ipa, gloss, level } : { term, ipa, gloss });
  }
  return out;
}

/** 仅认可 cet6/ielts/kaoyan；其他（cet4/rare/advanced/空等）当未知处理。*/
function normalizeDictLevel(s: string): 'cet6' | 'ielts' | 'kaoyan' | undefined {
  const t = s.toLowerCase().replace(/[^\w]/g, '');
  if (t === 'cet6') return 'cet6';
  if (t === 'ielts') return 'ielts';
  if (t === 'kaoyan') return 'kaoyan';
  return undefined;
}

/**
 * 解析批量模式的 "===N===" 分隔符输出为 string[]，index 对齐。
 * 若主路径（分隔符）未命中，降级尝试 JSON 格式（兼容不听话的强模型 / mock 测试）。
 */
export function parseDelimitedBatch(raw: string, expectedCount: number): string[] {
  const result = new Array(expectedCount).fill('');
  // 主路径：按 "===N===" 拆分（行首匹配）；split 把捕获组也放进结果中
  // 形如: ['前置噪声', '0', '内容0', '1', '内容1', ...]
  const parts = raw.split(/^===\s*(\d+)\s*===\s*$\n?/m);
  let anyHit = false;
  for (let i = 1; i < parts.length - 1; i += 2) {
    const idx = parseInt(parts[i], 10);
    if (!Number.isFinite(idx) || idx < 0 || idx >= expectedCount) continue;
    result[idx] = (parts[i + 1] || '').replace(/\n{3,}$/, '').trim();
    anyHit = true;
  }
  if (anyHit) return result;

  // 降级：旧 JSON 格式 {"results":[{"index":N,"translated":"..."}]}
  // 强模型偶尔忽略分隔符指令自行输出 JSON；原测试用例也用这个格式
  try {
    let jsonStr = raw.trim();
    const codeBlock = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) jsonStr = codeBlock[1].trim();
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
    }
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed?.results)) {
      for (const item of parsed.results) {
        const idx = item.index;
        if (typeof idx === 'number' && idx >= 0 && idx < expectedCount) {
          result[idx] = String(item.translated || '').trim();
        }
      }
    }
  } catch (_) { /* 两种都不命中：result 全空 */ }

  return result;
}

// ========== 具体 profile ==========

const MOONSHOT_PROFILE: ProviderProfile = {
  id: 'moonshot',
  matchBaseUrl: 'moonshot',
  endpointPath: '/chat/completions',
  // kimi-k2.5 官方建议 temperature=1；其他 Moonshot 模型用 0.3（创意↓可靠性↑）
  temperature: (s) => ((s.model || '').toLowerCase().includes('kimi-k2.5') ? 1 : 0.3),
  thinkingControl: 'omit',
  supportsStreaming: true,
  systemPromptSingle: SINGLE_PROMPT,
  systemPromptBatch: BATCH_PROMPT,
};

// Qwen3 / QwQ：默认开启 thinking；必须显式 enable_thinking:false 才会做翻译
// （不关会把 reasoning token 当翻译输出；关掉后性能更可预测）
const QWEN3_PROFILE: ProviderProfile = {
  id: 'qwen3',
  matchModel: /qwen3|qwq/i,
  endpointPath: '/chat/completions',
  temperature: () => 0.3,
  thinkingControl: 'enable-thinking-false',
  supportsStreaming: true,
  systemPromptSingle: SINGLE_PROMPT,
  systemPromptBatch: BATCH_PROMPT,
};

// Qwen2.5 / Qwen1.5 / 无版本号 Qwen；ADR: docs/decisions/qwen-legacy-temperature.md
const QWEN_LEGACY_PROFILE: ProviderProfile = {
  id: 'qwen-legacy',
  matchModel: /qwen/i,  // 顺序敏感：QWEN3 之后匹配，见 profiles.test.ts
  endpointPath: '/chat/completions',
  temperature: () => 0.1,
  thinkingControl: 'omit',
  supportsStreaming: false,
  systemPromptSingle: SINGLE_PROMPT,
  systemPromptBatch: BATCH_PROMPT,
};

const GLM46_PROFILE: ProviderProfile = {
  id: 'glm-4.6',
  matchModel: /glm-4[.\-]?6/i,
  endpointPath: '/chat/completions',
  temperature: () => 0.3,
  thinkingControl: 'thinking-disabled',
  supportsStreaming: true,
  systemPromptSingle: SINGLE_PROMPT,
  systemPromptBatch: BATCH_PROMPT,
};

// GLM-4-9B / 4-32B / 4-Plus 非 4.6 系列；ADR: docs/decisions/glm-legacy-streaming.md
// 顺序敏感：GLM46 之后匹配，见 profiles.test.ts
const GLM_LEGACY_PROFILE: ProviderProfile = {
  id: 'glm-legacy',
  matchModel: /glm-4/i,
  endpointPath: '/chat/completions',
  temperature: () => 0.3,
  thinkingControl: 'omit',
  supportsStreaming: false,
  systemPromptSingle: SINGLE_PROMPT,
  systemPromptBatch: BATCH_PROMPT,
};

// 任意 OpenAI 兼容 fallback：已知 profile 都不命中时兜底。
// 默认禁流式 —— 小模型（7-9B 级）的服务端普遍有 SSE 分片切 CJK 字符问题，
// 宁可保守也别冒字符坏损的风险。确认某个 endpoint 流式安全再单独加 profile 打开。
const GENERIC_PROFILE: ProviderProfile = {
  id: 'generic-openai',
  endpointPath: '/chat/completions',
  temperature: () => 0.3,
  thinkingControl: 'omit',
  supportsStreaming: false,
  systemPromptSingle: SINGLE_PROMPT,
  systemPromptBatch: BATCH_PROMPT,
};

// 顺序敏感：
//   - QWEN3 必须在 QWEN_LEGACY 之前，否则 /qwen/i 会先命中把 qwen3 也吞掉
//   - GLM46 必须在 GLM_LEGACY 之前，否则 /glm-4/i 会先命中把 4.6 也吞掉
const PROFILES: ProviderProfile[] = [
  MOONSHOT_PROFILE,
  QWEN3_PROFILE,
  QWEN_LEGACY_PROFILE,
  GLM46_PROFILE,
  GLM_LEGACY_PROFILE,
];

export function getProfile(settings: { baseUrl?: string; model?: string }): ProviderProfile {
  const url = String(settings.baseUrl || '').toLowerCase();
  const model = String(settings.model || '');
  for (const p of PROFILES) {
    if (p.matchBaseUrl && url.includes(p.matchBaseUrl)) return p;
    if (p.matchModel && p.matchModel.test(model)) return p;
  }
  return GENERIC_PROFILE;
}

/** 拼完整 API 端点 URL */
export function resolveEndpoint(profile: ProviderProfile, baseUrl: string): string {
  return `${(baseUrl || '').replace(/\/$/, '')}${profile.endpointPath}`;
}
