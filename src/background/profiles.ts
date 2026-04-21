// 模型提供方注册表（Provider profile registry）
//
// 集中描述每个模型提供方的调用参数：endpoint 路径、温度、思考模式控制字段、
// 流式支持、system prompt 模板。新增模型只需加一个 profile 条目，
// 无需改 api.ts 的 body 构造逻辑。
//
// Profile 的匹配顺序：第一个命中的生效；`matchBaseUrl`（子串匹配）和
// `matchModel`（正则匹配）任一命中即算。都不命中则回落到 GENERIC_PROFILE。

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
//   - 多条批量 → <tN>...</tN> XML 标签（比 ===N=== 更稳定；bench 实测 GLM/Qwen3 100% 遵循率，
//     Qwen2.5 "on" 退化会污染标签但该模型已从 UI 移除）
//   - 严格模式 → 通用前缀，可拼到任意 prompt 前
// 历史教训：
//   - JSON 示例里的中文占位符（如"第一条翻译"）会被 7-9B 小模型当 template 照抄
//   - ===N=== 分隔符在 Qwen2.5 上偶发只输出 "=== N"（无尾 ===），切 <tN>/</tN> 闭合对更稳健
//   - 原文可能碰巧含 <tN> 字符串（代码片段、HTML 教学推文等），所以每次请求用 findSafeOffset
//     选一个不与原文冲突的起始 N（默认 0；如果 0-N 冲突则偏移 100/1000）

const SINGLE_PROMPT = (lang: string) => `请将用户提供的文本翻译成${lang}。

规则：
1. 输出必须完全是${lang}；专有名词可音译或保留原样。
2. 如果原文已经是${lang}，直接返回原文（保留段落结构）。
3. 只输出翻译结果，不要前缀（如"翻译："）、不要解释、不要 markdown 代码块。
4. 保留原文的段落结构（段落之间用空行分隔）。
5. 保持原文的语气、风格（口语化、幽默、讽刺等）。`;

const BATCH_PROMPT = (lang: string) => `请将以下多条推文分别翻译成${lang}。
每条推文在用户消息中用 XML 标签 <tN>...</tN> 包裹（N 为数字索引，用户会给出具体值）。

输出格式（严格遵守）：
按相同的 <tN>...</tN> 标签结构输出对应译文，标签里的 N 必须与用户消息里的 N 一一对应（不得改写、不得使用其他数字）。

规则：
1. 每条译文必须写在对应的 <tN> 与 </tN> 之间。
2. 译文中的段落分隔用真实空行保留；不要 JSON 转义。
3. 输出必须完全是${lang}；专有名词可保留原样。
4. 不要 markdown 代码块、不要解释、不要在标签外输出任何文字。
5. 如果某条原文已是${lang}，按原文返回（含段落结构）。`;

// 严格前缀 —— 拼在单条或批量 prompt 前，用于质量重试场景。
// 显式禁止总结、强调段落保留；行为独立于输出格式（分隔符 or 纯文本）。
const STRICT_PREFIX = (lang: string) => `【严格模式必须遵守】
1. 完整翻译原文每一句，严禁省略、合并、总结或概括。
2. 原文有 N 段（空行分隔）→ 译文必须 N 段，段与段之间保留空行。
3. 输出必须完全是${lang}；不得整句保留原文英文。
4. 保留 URL / @用户名 / #话题词 的原样（不翻译这些 token）。

`;

// Combined call（翻译 + 字典融合）：仅在 batch 里追加。user message 会给需要字典的
// 条目在 <tN> 的开始标签上加 `dict="word1 word2 ..."` 属性；模型按 ---DICT--- 段输出。
//
// level 用中国学生熟悉的考试分级（详见 docs/superpowers/reports/2026-04-20-glm-mixed-request-benchmark.md）：
// GLM-4-9B 在 32 词金标集上 cet4/cet6/ielts/kaoyan 四分类 96.88% 准确。
// 候选词已经在插件端用 Zipf + 音节 + 词长 本地预筛 —— 模型只需给 IPA / 释义 / level。
const BATCH_DICT_SUFFIX = (lang: string) => `

【字典融合】
开始标签带 dict 属性的条目（形如 <tN dict="word1 word2">）需在译文后、关闭标签 </tN> 前追加字典块；无 dict 属性的条目不要加字典块。
dict 属性里的词是预筛过的高难候选，字典条目只能从这些候选里选。

字典块格式（---DICT--- 单独一行，之后每行一条，四段式竖线分隔）：

<tN dict="w1 w2 w3">
<译文>
---DICT---
原词|/IPA/|${lang}释义|level
原词2|/IPA/|${lang}释义|level
</tN>

字典规则：
1. 条目必须来自 dict 属性的候选词；候选外的词一律不要注释。
2. level 从 {cet6, ielts, kaoyan} 选 —— 分别对应六级 / 雅思 / 考研。
3. IPA 写国际音标，两头用斜线包裹；释义用${lang}，简短（≤8 字），不要整句解释。
4. 若候选都不需要注释，直接省略 ---DICT--- 段，不要写空段。
5. 无 dict 属性的条目一律不输出 ---DICT--- 段；多写会让解析失败。`;

// 试试手气 — 用户点击品牌 logo 触发的重译加强前缀。强调"精准 / 更地道 / 上下文一致"，
// 鼓励模型给出与上次不同角度但仍然忠实的翻译。配合 temperature 上浮使用。
const BOOST_PREFIX = (lang: string) => `【重译请求】用户对上一次译文不满意，请用更精准、地道的${lang}重新翻译。
1. 保持原文语义完整，不得删减或合并句子。
2. 避免机械直译；遇到固定搭配 / 专有说法，优先采用目标语自然的表达。
3. 若上下文已明确，允许在保留原意的前提下换用不同措辞，避免与上一版雷同。

`;

/** 根据 profile + 是否批量 + 是否严格模式 + 是否字典融合 / 重译加强，组装最终的 system prompt */
export function composeSystemPrompt(
  profile: ProviderProfile,
  lang: string,
  opts: { batch: boolean; strict: boolean; smartDict?: boolean; retranslateBoost?: boolean },
): string {
  const base = opts.batch ? profile.systemPromptBatch(lang) : profile.systemPromptSingle(lang);
  const dictSuffix = opts.batch && opts.smartDict ? BATCH_DICT_SUFFIX(lang) : '';
  const boostPrefix = opts.retranslateBoost ? BOOST_PREFIX(lang) : '';
  const strictPrefix = opts.strict ? STRICT_PREFIX(lang) : '';
  return boostPrefix + strictPrefix + base + dictSuffix;
}

import type { DictionaryEntry } from '../shared/types';

/**
 * 查找一个安全的起始 offset，使得 <t{offset}> .. <t{offset+count-1}> 都不与 texts 里
 * 已有的 `<tN>` 字符串冲突。
 *
 * 为什么需要：原文可能是代码片段 / HTML 教学 / AI 编程推文，恰好含 `<t0>` 或 `</t5>`。
 * 此时 parser 的 `<t(\d+)>...</t\1>` 正则会把原文里的标签当成分隔符，翻译串到错误的槽里。
 *
 * 策略：默认 0；冲突时试 100 / 1000 / 10000。只要原文不含 `<t100>` 这种字面串就安全，
 * 而真实推文里出现 `<t100>` 的概率基本为零。同时检查 `</tN>` 闭合对，防止半边冲突。
 */
export function findSafeOffset(texts: string[], count: number): number {
  const combined = texts.join('\n');
  for (const candidate of [0, 100, 1000, 10000, 100000]) {
    let collision = false;
    for (let i = 0; i < count; i++) {
      const n = candidate + i;
      // 开始标签可带属性（dict="..."），所以用 "<tN>" 或 "<tN " 两种前缀都视为冲突
      if (
        combined.includes(`<t${n}>`) ||
        combined.includes(`<t${n} `) ||
        combined.includes(`</t${n}>`)
      ) {
        collision = true;
        break;
      }
    }
    if (!collision) return candidate;
  }
  return 100000; // 兜底；实际永远走不到（推文包含 `<t100000>` 的概率 ~ 0）
}

/**
 * 构造 batch 的 user message。每条用 `<tN>...</tN>` 包裹（N = offset + i）；
 * 当该 index 在 smartDictIndices 里、且 perItemCandidates 提供了词列表时，开始标签
 * 追加 `dict="w1 w2"` 属性指示模型输出字典块。
 *
 * @param offset 由 findSafeOffset 计算，用于避免原文碰撞；默认 0（向后兼容 / 测试便利）
 */
export function buildBatchUserContent(
  texts: string[],
  smartDictIndices?: Set<number>,
  perItemCandidates?: (string[] | null | undefined)[],
  offset = 0,
): string {
  return texts
    .map((t, i) => {
      const n = offset + i;
      let dictAttr = '';
      if (smartDictIndices && smartDictIndices.has(i)) {
        const candidates = perItemCandidates?.[i];
        if (candidates && candidates.length > 0) {
          // 候选词是本地预筛过的 ASCII 单词，不会含引号 / 尖括号 —— 无需转义
          dictAttr = ` dict="${candidates.join(' ')}"`;
        }
      }
      return `<t${n}${dictAttr}>\n${t}\n</t${n}>`;
    })
    .join('\n\n');
}

/**
 * 解析 combined 响应：同时抽取译文 + 字典。
 * 主路径匹配 `<tN ...>...</tN>`（N = offset + i，i 为 texts 下标）；
 * tag 内内容按 `---DICT---` 拆分，前段译文、后段字典。
 *
 * 降级：若 `<tN>` 主路径零命中（模型忽略指令 / e2e mock 仍用老格式），回落到 parseDelimitedBatch
 * 的 `===N===` / JSON 路径；此时 dictEntries 保持全 null，字典走 content 端独立 API 兜底。
 */
export function parseDelimitedBatchWithDict(
  raw: string,
  expectedCount: number,
  offset = 0,
): { translations: string[]; dictEntries: (DictionaryEntry[] | null)[] } {
  const translations = new Array<string>(expectedCount).fill('');
  const dictEntries = new Array<DictionaryEntry[] | null>(expectedCount).fill(null);

  // `<t(\d+)[^>]*>` 允许开始标签带属性（如 dict="..."）；`\1` 反向引用保证闭合数字一致
  const re = /<t(\d+)[^>]*>([\s\S]*?)<\/t\1>/g;
  let anyHit = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const rawIdx = parseInt(m[1], 10);
    const i = rawIdx - offset;
    if (!Number.isFinite(i) || i < 0 || i >= expectedCount) continue;
    const chunk = m[2] || '';

    // DICT 分隔：前后至少 2 个连字号 + "DICT"（大小写宽松）
    const dictSplit = chunk.split(/\n\s*-{2,}\s*DICT\s*-{2,}\s*\n?/i);
    translations[i] = (dictSplit[0] || '').replace(/\n{3,}$/, '').trim();
    anyHit = true;

    if (dictSplit.length > 1) {
      const entries = parseDictLines(dictSplit.slice(1).join('\n'));
      if (entries.length > 0) dictEntries[i] = entries;
    }
  }
  if (anyHit) return { translations, dictEntries };

  // 回落：老格式（===N=== / JSON）；dictEntries 保持全 null
  return { translations: parseDelimitedBatch(raw, expectedCount, offset), dictEntries };
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
 * 解析批量模式响应为 string[]，index 对齐。
 * 三层解析，按优先级：
 *   1. `<tN>...</tN>` XML 标签（当前主路径；N = offset + i，用 `\1` 反向引用保证闭合一致）
 *   2. `===N===` 分隔符（legacy；小模型偶发回退 + e2e mock 仍用此格式）
 *   3. JSON `{"results":[{"index":N,"translated":"..."}]}`（强模型忽略指令时）
 */
export function parseDelimitedBatch(raw: string, expectedCount: number, offset = 0): string[] {
  const result = new Array<string>(expectedCount).fill('');

  // 主路径：<tN>...</tN>（非贪婪 + 反向引用）
  const tagRe = /<t(\d+)[^>]*>([\s\S]*?)<\/t\1>/g;
  let tagHit = false;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(raw)) !== null) {
    const rawIdx = parseInt(m[1], 10);
    const i = rawIdx - offset;
    if (!Number.isFinite(i) || i < 0 || i >= expectedCount) continue;
    // tag 内可能带 ---DICT--- 段（当 combined call 降级到 parseDelimitedBatch 时仍要剥掉）
    const chunk = (m[2] || '').split(/\n\s*-{2,}\s*DICT\s*-{2,}/i)[0];
    result[i] = chunk.replace(/\n{3,}$/, '').trim();
    tagHit = true;
  }
  if (tagHit) return result;

  // Fallback 1：老 ===N=== 分隔符。index 按字面取（不减 offset）——
  // legacy 响应里的索引是基于 0 的（mock / 模型回退输出），不会用 offset。
  // 宽松：结尾 === 允许缺失；用 [ \t]* 防止 \s* 吃掉换行导致内容被卷进分隔符
  const parts = raw.split(/^={2,}[ \t]*(\d+)[ \t]*(?:={2,})?[^\n]*\n?/m);
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
