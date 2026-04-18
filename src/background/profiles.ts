// Provider profile registry
//
// 集中描述每个模型提供方的调用参数：endpoint 路径、温度、思考模式控制字段、
// streaming 支持、system prompt 模板。新增模型只需加一个 profile 条目，
// 无需改 api.ts 的 body 构造逻辑。
//
// Profile 的匹配顺序：第一个命中的生效；`matchBaseUrl`（substring）和
// `matchModel`（regex）任一命中即算。都不命中则回落到 GENERIC_PROFILE。

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

/** 根据 profile + 是否批量 + 是否严格模式，组装最终的 system prompt */
export function composeSystemPrompt(
  profile: ProviderProfile,
  lang: string,
  opts: { batch: boolean; strict: boolean },
): string {
  const base = opts.batch ? profile.systemPromptBatch(lang) : profile.systemPromptSingle(lang);
  return opts.strict ? STRICT_PREFIX(lang) + base : base;
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

// Qwen2.5 及更早：
//   - 无 thinking 参数（误传 enable_thinking 会 400 或诱发 "on on on" 退化循环）
//   - 温度敏感：实测 T=0.3 在 280+ 字符输入上约 30% 概率陷入退化循环，4422 token 爆 max_tokens；
//     T=0.7/1.0 更不稳定。T=0.1 是唯一能稳定处理长文本的温度（bench v2 实测）。
//     并且 T=0.1 也减少短文本的数字类错误（如 "2028 年"→"208 年"）。
//   - 流式输出偶发乱码（输出里出现 U+FFFD / `�`）：SiliconFlow 上的 Qwen2.5-7B 在 CJK
//     翻译中有小概率在 SSE 分片边界切断多字节 UTF-8 字符，服务端下发时已带 `�`。
//     禁用 streaming 强制走 `response.json()` 整包解码，这个问题消失。
const QWEN_LEGACY_PROFILE: ProviderProfile = {
  id: 'qwen-legacy',
  matchModel: /qwen/i,  // 排序放在 QWEN3 之后，先匹配 qwen3，兜住 qwen2.5 / qwen1.5 / Pro/Qwen 等
  endpointPath: '/chat/completions',
  temperature: () => 0.1,  // 从 0.3 降到 0.1：bench v2 实测稳定门槛
  thinkingControl: 'omit',
  supportsStreaming: false,  // 流式下发偶发 `�` 乱码，禁用
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

// 任意 OpenAI 兼容 fallback（SiliconFlow 上的 GLM-4-9B 等走这里）
const GENERIC_PROFILE: ProviderProfile = {
  id: 'generic-openai',
  endpointPath: '/chat/completions',
  temperature: () => 0.3,
  thinkingControl: 'omit',
  supportsStreaming: true,
  systemPromptSingle: SINGLE_PROMPT,
  systemPromptBatch: BATCH_PROMPT,
};

// 顺序敏感：QWEN3 必须在 QWEN_LEGACY 之前，否则 /qwen/i 会先命中把 qwen3 也吞掉。
const PROFILES: ProviderProfile[] = [MOONSHOT_PROFILE, QWEN3_PROFILE, QWEN_LEGACY_PROFILE, GLM46_PROFILE];

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
