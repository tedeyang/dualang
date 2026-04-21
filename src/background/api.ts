import { reportFatalError, clearErrorState } from './error-report';
import {
  getProfile,
  resolveEndpoint,
  composeSystemPrompt,
  parseDelimitedBatch,
  parseDelimitedBatchWithDict,
  buildBatchUserContent,
  findSafeOffset,
  LANG_DISPLAY,
  type ProviderProfile,
} from './profiles';
import { iterateSseDeltas } from './sse';
import { filterHardCandidates } from './difficulty';
import type { Settings, TokenUsage, DictionaryEntry } from '../shared/types';

// ===================== 思考模式控制 =====================
// 翻译任务不需要推理；关闭方式按 provider profile.thinkingControl 分发：
//   - 'omit':                      省略 reasoning_effort 即关闭（Moonshot / OpenAI 等）
//   - 'enable-thinking-false':     body.enable_thinking = false（Qwen 系列）
//   - 'thinking-disabled':         body.thinking = { type: 'disabled' }（GLM-4.6+）
// 具体哪个模型用哪条策略由 src/background/profiles.ts 登记。
// 试试手气重译时的温度调整：在 profile 基准温度上 +Δ，但夹在 [0, 0.9] 区间。
// 小模型在 >0.9 时容易跑偏，所以上限保守。调用点不再直接 profile.temperature(settings)。
function effectiveTemperature(profile: ProviderProfile, settings: Settings): number {
  const base = profile.temperature(settings);
  const boost = (settings as any).temperatureBoost || 0;
  if (!boost) return base;
  return Math.max(0, Math.min(0.9, base + boost));
}

export function applyThinkingMode(body: any, settings: Settings, profile?: ProviderProfile): void {
  const effort = settings.reasoningEffort;
  const wantThinking = !!effort && effort !== 'none';

  if (wantThinking) {
    body.reasoning_effort = effort;
    return;
  }

  const p = profile || getProfile(settings);
  switch (p.thinkingControl) {
    case 'enable-thinking-false':
      body.enable_thinking = false;
      break;
    case 'thinking-disabled':
      body.thinking = { type: 'disabled' };
      break;
    case 'omit':
    default:
      // 省略 reasoning_effort 即关闭，无需额外字段
      break;
  }
}

// ===================== body 构造辅助 =====================

function maxTokensPerItem(settings: Settings): number | undefined {
  const n = parseInt(String(settings.maxTokens ?? ''), 10);
  return !isNaN(n) && n > 0 ? n : undefined;
}

function maxTokensForBatch(settings: Settings, texts: string[]): number | undefined {
  const maxPerItem = maxTokensPerItem(settings);
  if (maxPerItem === undefined) return undefined;
  // 输出长度 ≈ 输入 / 3 + 每条 80 token 的 JSON 结构开销；取与 user 设置上限的较大者
  const inputChars = texts.reduce((sum, t) => sum + t.length, 0);
  const estimatedOutput = Math.ceil(inputChars / 3) + texts.length * 80;
  return Math.max(maxPerItem * texts.length, estimatedOutput);
}

// ===================== API 错误分类 =====================

export function classifyApiError(status: number, bodyText: string) {
  let errorType = '';
  let errorMessage = bodyText;
  try {
    const parsed = JSON.parse(bodyText);
    errorType = parsed.error?.type || '';
    errorMessage = parsed.error?.message || bodyText;
  } catch (e) {}

  const type = String(errorType).toLowerCase();
  const msg = String(errorMessage).toLowerCase();

  if (status === 429 && type === 'exceeded_current_quota_error') {
    return { retryable: false, message: '账户额度不足或已停用，请检查账户余额和账单详情' };
  }
  if (status === 429 && type === 'engine_overloaded_error') {
    return { retryable: true, message: '翻译服务繁忙，请稍后重试', retryAfter: 5 };
  }
  if (status === 429 && type === 'rate_limit_reached_error') {
    const secondsMatch = errorMessage.match(/after\s+(\d+)\s+seconds/i);
    const retryAfter = secondsMatch ? parseInt(secondsMatch[1], 10) : 10;
    return { retryable: true, message: '请求过于频繁，触发速率限制，请稍后重试', retryAfter };
  }
  if (status === 400) {
    if (type === 'content_filter') return { retryable: false, message: '内容审查未通过，输入或生成内容包含敏感信息' };
    if (msg.includes('token length too long') || msg.includes('token limit')) return { retryable: false, message: '推文内容过长，超出模型 token 限制' };
    return { retryable: false, message: `请求格式错误: ${errorMessage}` };
  }
  if (status === 401) return { retryable: false, message: 'API Key 无效或已过期，请在扩展设置中检查' };
  if (status === 403) return { retryable: false, message: '没有权限访问该 API，请联系管理员' };
  if (status === 404) return { retryable: false, message: `模型不存在或无权访问: ${errorMessage}` };
  if (status >= 500) return { retryable: true, message: `翻译服务端错误 (${status})，请稍后重试`, retryAfter: 3 };

  return { retryable: status >= 500 || status === 429, message: `翻译 API 错误 (${status}): ${errorMessage}`, retryAfter: 3 };
}

// ===================== 响应解析 =====================

export async function parseApiResponse(response: Response, isStream: boolean) {
  if (!response.ok) {
    const errText = await response.text().catch(() => 'Unknown error');
    const errInfo = classifyApiError(response.status, errText);
    const e: any = new Error(errInfo.message);
    e.retryable = errInfo.retryable;
    e.retryAfter = errInfo.retryAfter;
    throw e;
  }

  if (isStream) {
    const translated = await parseStream(response);
    if (!translated) throw new Error('翻译 API 流式返回结果为空');
    return { translated };
  } else {
    return await response.json();
  }
}

// ===================== 重试 =====================

export async function callWithRetry(fn: () => Promise<any>, maxRetries = 3, settings: Settings | null = null) {
  let lastError: any;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const result = await fn();
      clearErrorState().catch(() => {});
      return result;
    } catch (err: any) {
      lastError = err;
      // 抢占 / AbortError（如 hedged 败者被 abort、rateLimiter 抢占）都是"预期取消"，
      // 不重试也不上报 fatal banner。仅直接向上抛让调用链自行处理。
      const isAbort = err?.name === 'AbortError' || err?.preempted;
      if (isAbort) throw err;
      if (!err.retryable || i >= maxRetries) {
        if (!err.retryable) {
          reportFatalError(err.message, settings?.baseUrl).catch(() => {});
        }
        throw err;
      }
      const delay = (err.retryAfter || Math.pow(2, i)) * 1000;
      console.log(`[Dualang] API 请求失败，${delay}ms 后重试 (${i + 1}/${maxRetries}): ${err.message}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

// ===================== 流式解析 =====================

async function parseStream(response: Response) {
  let result = '';
  for await (const delta of iterateSseDeltas(response)) result += delta;
  return result.trim();
}

// ===================== 翻译请求 =====================

export async function doTranslateSingle(text: string, settings: Settings, signal?: AbortSignal, strictMode = false) {
  const profile = getProfile(settings);
  const endpoint = resolveEndpoint(profile, settings.baseUrl || 'https://api.moonshot.cn/v1');
  const targetLangDisplay = LANG_DISPLAY[settings.targetLang] || settings.targetLang;

  const systemPrompt = composeSystemPrompt(profile, targetLangDisplay, {
    batch: false, strict: strictMode, retranslateBoost: !!(settings as any).retranslateBoost,
  });

  const body: any = {
    model: settings.model || 'kimi-k2.5',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text }
    ],
    temperature: effectiveTemperature(profile, settings),
    stream: profile.supportsStreaming && !!settings.enableStreaming,
  };

  const mt = maxTokensPerItem(settings);
  if (mt !== undefined) body.max_tokens = mt;
  applyThinkingMode(body, settings, profile);

  const data = await callWithRetry(() => fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}` },
    body: JSON.stringify(body),
    signal
  }).then(r => parseApiResponse(r, body.stream)), 3, settings);

  return data;
}

export async function doAnnotateDictionary(
  text: string,
  settings: Settings,
  candidates: string[],
  signal?: AbortSignal,
): Promise<{ entries: DictionaryEntry[] }> {
  const profile = getProfile(settings);
  const endpoint = resolveEndpoint(profile, settings.baseUrl || 'https://api.moonshot.cn/v1');
  const targetLangDisplay = LANG_DISPLAY[settings.targetLang] || settings.targetLang;

  // 到这里 candidates 应该已经被调用方用 filterHardCandidates 预筛过；
  // doAnnotateDictionary 只负责把筛好的词拼 prompt 发给模型。
  if (candidates.length === 0) return { entries: [] };
  const candidateList = candidates.join(', ');

  // level 用 GLM 金标校准的考试分级（docs/superpowers/reports/2026-04-20-glm-mixed-request-benchmark.md）
  // 策略：候选已在本地难度阈值以上筛出；模型只做"打标签 + 给 IPA/释义"两件事，不再做筛选判断。
  const systemPrompt =
    `你是英文词汇助手。为给定的高难英文词（已经本地预筛）生成 IPA 音标 + ${targetLangDisplay}释义 + 难度级别。` +
    `输出严格 JSON：{"entries":[{"term":"","ipa":"","gloss":"","level":"cet6|ielts|kaoyan"}]}。` +
    `level 从 {cet6, ielts, kaoyan} 选 —— 六级 / 雅思 / 考研，按词的实际难度判断。` +
    `gloss 用${targetLangDisplay}，简短（≤8 字），不要整句解释。` +
    `候选词都应该收录；若某词确实不该注释可以省略。每个条目必须有 term 和（ipa 或 gloss）。`;

  const body: any = {
    model: settings.model || 'kimi-k2.5',
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content:
          `TEXT:\n${text}\n\n` +
          `CANDIDATES:\n${candidateList}\n\n` +
          `只从 CANDIDATES 中选词；无合适词时返回 {"entries":[]}。`,
      },
    ],
    temperature: 0.1,
    stream: false,
  };
  applyThinkingMode(body, settings, profile);

  const data = await callWithRetry(() => fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}` },
    body: JSON.stringify(body),
    signal
  }).then(r => parseApiResponse(r, false)), 3, settings);

  const raw = data?.choices?.[0]?.message?.content?.trim();
  if (!raw) return { entries: [] };
  const cleaned = stripMarkdownCode(raw);
  try {
    const parsed = JSON.parse(cleaned);
    const list = Array.isArray(parsed) ? parsed : parsed?.entries;
    if (!Array.isArray(list)) return { entries: [] };
    const entries = list
      .map((e: any) => {
        const levelRaw = String(e?.level || '').toLowerCase().replace(/[^\w]/g, '');
        const level = levelRaw === 'cet6' || levelRaw === 'ielts' || levelRaw === 'kaoyan'
          ? (levelRaw as 'cet6' | 'ielts' | 'kaoyan')
          : undefined;
        const entry: DictionaryEntry = {
          term: String(e?.term || '').trim(),
          ipa: String(e?.ipa || '').trim(),
          gloss: String(e?.gloss || '').trim(),
        };
        if (level) entry.level = level;
        return entry;
      })
      .filter((e: DictionaryEntry) => !!e.term && (!!e.ipa || !!e.gloss));
    return { entries };
  } catch (_) {
    return { entries: [] };
  }
}

// ===================== 流式批量翻译（逐条推送）=====================

export type OnStreamResult = (index: number, translated: string) => void;

/**
 * 流式批量翻译：SSE stream + 增量 `<tN>...</tN>` 标签提取。
 * 一旦累积缓冲区里出现 `</t{offset+i}>`，就把 [开始标签末尾, 闭合位置) 之间的内容作为
 * 第 i 条的完成译文推送。对比老的 ===N=== 方案，闭合标签是明确的完成信号，不用"等下一个
 * 分隔符出现才知道前一个完了"，最后一条也能在流结束前推出。
 */
export async function doTranslateBatchStream(
  texts: string[],
  settings: Settings,
  signal: AbortSignal | null,
  onResult: OnStreamResult,
  strictMode = false,
): Promise<{ translations: string[]; usage?: TokenUsage }> {
  const profile = getProfile(settings);
  const endpoint = resolveEndpoint(profile, settings.baseUrl || 'https://api.moonshot.cn/v1');
  const targetLangDisplay = LANG_DISPLAY[settings.targetLang] || settings.targetLang;

  const isSingle = texts.length === 1;
  const tagOffset = isSingle ? 0 : findSafeOffset(texts, texts.length);
  const systemPrompt = composeSystemPrompt(profile, targetLangDisplay, {
    batch: !isSingle, strict: strictMode,
    retranslateBoost: !!(settings as any).retranslateBoost,
  });
  const userContent = isSingle
    ? texts[0]
    : buildBatchUserContent(texts, undefined, undefined, tagOffset);

  const body: any = {
    model: settings.model || 'kimi-k2.5',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: effectiveTemperature(profile, settings),
    stream: true,
  };

  const mt = maxTokensForBatch(settings, texts);
  if (mt !== undefined) body.max_tokens = mt;
  applyThinkingMode(body, settings, profile);

  const response = await callWithRetry(() => fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}` },
    body: JSON.stringify(body),
    signal: signal ?? undefined
  }).then(r => {
    if (!r.ok) return parseApiResponse(r, false); // 会 throw
    return r;
  }), 3, settings) as Response;

  let accumulated = '';
  const emittedIndices = new Set<number>();

  // 预编译 per-item 开闭标签匹配（避免每个 delta 都重建 regex）
  // 开始标签可带 dict 属性（`<t0 dict="...">`），用 `(?=[\s>])` 保证 `<t1` 不误匹配 `<t10`
  const openPatterns = texts.map((_, i) => new RegExp(`<t${tagOffset + i}(?=[\\s>])[^>]*>`));
  const closeTags = texts.map((_, i) => `</t${tagOffset + i}>`);

  function tryEmitCompleted() {
    if (isSingle) return;  // 单条不做增量推送
    for (let i = 0; i < texts.length; i++) {
      if (emittedIndices.has(i)) continue;
      const closePos = accumulated.indexOf(closeTags[i]);
      if (closePos === -1) continue;
      const openMatch = openPatterns[i].exec(accumulated);
      if (!openMatch || openMatch.index >= closePos) continue;
      const chunk = accumulated.slice(openMatch.index + openMatch[0].length, closePos);
      // 剥离 ---DICT--- 段（流式默认不要字典但防御性保留）
      const translation = chunk
        .split(/\n\s*-{2,}\s*DICT\s*-{2,}/i)[0]
        .replace(/^\n+/, '')
        .replace(/\n{3,}$/, '')
        .trim();
      if (translation) {
        emittedIndices.add(i);
        onResult(i, translation);
      }
    }
  }

  for await (const delta of iterateSseDeltas(response)) {
    accumulated += delta;
    tryEmitCompleted();
  }

  // 终局解析：单条纯文本 or 标签/分隔符切分
  if (isSingle) {
    const content = stripMarkdownCode(accumulated.trim());
    if (!emittedIndices.has(0) && content) {
      onResult(0, content);
    }
    return { translations: [content] };
  }

  const translations = parseDelimitedBatch(accumulated, texts.length, tagOffset);
  // 补推流式未覆盖的条目（模型输出标签不闭合时由 parseDelimitedBatch 的 === fallback 兜底）
  for (let i = 0; i < translations.length; i++) {
    if (translations[i] && !emittedIndices.has(i)) {
      emittedIndices.add(i);
      onResult(i, translations[i]);
    }
  }
  if (emittedIndices.size === 0) {
    throw new Error(`流式批量翻译解析失败（未找到 <tN> 标签或 ===N=== 分隔符），原始内容: ${accumulated.slice(0, 200)}`);
  }
  return { translations };
}

export interface BatchRequestOptions {
  /** 需要字典融合的 index 集合（基于 texts 的 0-based 下标）。非空时启用 combined call。*/
  smartDictIndices?: Set<number>;
  /**
   * 与 texts 对齐；每条的候选词列表（本地难度预筛后的高难词）。
   * 结合 smartDictIndices 用 —— 模型被限定只能从这些候选里选词做字典。
   * 候选为空 / null 的 index 虽在 smartDictIndices 里也不会打 "(dict)" 标（没词可选）。
   */
  perItemCandidates?: (string[] | null | undefined)[];
}

/**
 * combined call 会话级熔断：某个 model 连续 3 次 combined parse 失败后，本会话不再尝试
 * combined；让 content 的分离 annotateDictionary 路径兜底。Service Worker 重启即复位。
 * 这避免了"每次请求都浪费一次 combined → 重试"的无谓 2x 成本。
 */
const combinedFailures = new Map<string, number>();
const COMBINED_DISABLE_THRESHOLD = 3;
function isCombinedDisabled(model: string | undefined): boolean {
  return (combinedFailures.get(model || '') || 0) >= COMBINED_DISABLE_THRESHOLD;
}
function recordCombinedFailure(model: string | undefined): void {
  const key = model || '';
  combinedFailures.set(key, (combinedFailures.get(key) || 0) + 1);
}
function recordCombinedSuccess(model: string | undefined): void {
  const key = model || '';
  // 连续失败计数器：一次成功即清零（避免间歇性失败永久拉黑）
  combinedFailures.delete(key);
}

export async function doTranslateBatchRequest(
  texts: string[],
  settings: Settings,
  signal: AbortSignal | null,
  maxRetries = 3,
  strictMode = false,
  options: BatchRequestOptions = {},
): Promise<{
  translations: string[];
  dictEntries?: (DictionaryEntry[] | null)[];
  usage?: TokenUsage;
}> {
  const profile = getProfile(settings);
  const endpoint = resolveEndpoint(profile, settings.baseUrl || 'https://api.moonshot.cn/v1');
  const targetLangDisplay = LANG_DISPLAY[settings.targetLang] || settings.targetLang;

  // 输出格式：纯文本 vs ===N=== 分隔符。
  //   - 多条 batch：必须用分隔符（否则无法切分）
  //   - 单条 + 字典融合：也用分隔符 —— 合并翻译 + 字典进一次 API，跳过独立 annotateDictionary
  //     （X 滚动时 90%+ 的 sub-batch 是单条英文推文，以前 combined 基本不触发；现在每条都能用上）
  //   - 单条无字典：纯文本最轻量
  // 熔断：本会话该 model 连续 combined 失败 ≥ 阈值 → 强制关字典，由 content 分离字典 API 兜底。
  const isSingle = texts.length === 1;
  const dictRequested = options.smartDictIndices && options.smartDictIndices.size > 0;
  const dictIndices = dictRequested && !isCombinedDisabled(settings.model)
    ? options.smartDictIndices
    : undefined;
  const useStructured = !isSingle || !!dictIndices;
  // 避免原文里碰巧含 <tN> 字符串（如 AI 教学 / 代码推文）打断 parser
  const tagOffset = useStructured ? findSafeOffset(texts, texts.length) : 0;
  const systemPrompt = composeSystemPrompt(profile, targetLangDisplay, {
    batch: useStructured, strict: strictMode, smartDict: !!dictIndices,
    retranslateBoost: !!(settings as any).retranslateBoost,
  });
  const userContent = useStructured
    ? buildBatchUserContent(texts, dictIndices, options.perItemCandidates, tagOffset)
    : texts[0];

  const body: any = {
    model: settings.model || 'kimi-k2.5',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: effectiveTemperature(profile, settings),
    stream: false,
  };

  const mt = maxTokensForBatch(settings, texts);
  if (mt !== undefined) {
    // 字典融合会让输出变长（每条条目额外 ~30-60 tokens）；按字典条目数轻度放大
    body.max_tokens = dictIndices ? Math.ceil(mt * 1.25) + dictIndices.size * 120 : mt;
  }
  applyThinkingMode(body, settings, profile);

  const data = await callWithRetry(() => fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}` },
    body: JSON.stringify(body),
    signal: signal ?? undefined
  }).then(r => parseApiResponse(r, false)), maxRetries, settings);

  const raw = data.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error('API 返回结果为空');

  // 单条无字典：纯文本解析，容错兼容模型忽略指令吐 JSON / 标签 / 分隔符的情形
  if (!useStructured) {
    const cleaned = stripMarkdownCode(raw);
    if (/^\s*[{[]/.test(cleaned) || /<t\d+[^>]*>/.test(cleaned) || /^===\s*\d+\s*===/m.test(cleaned)) {
      const fallback = parseDelimitedBatch(cleaned, 1);
      if (fallback[0]) return { translations: fallback, usage: data.usage };
    }
    return { translations: [cleaned], usage: data.usage };
  }

  // 结构化路径：字典模式走带 ---DICT--- 的解析；否则用老的分隔符解析
  if (dictIndices) {
    const { translations, dictEntries } = parseDelimitedBatchWithDict(raw, texts.length, tagOffset);
    const successCount = translations.filter((t) => t && t.length > 0).length;
    if (successCount > 0) {
      recordCombinedSuccess(settings.model);
      return { translations, dictEntries, usage: data.usage };
    }
    // 小模型偶尔被"<tN dict=...> + ---DICT---"的双层结构打懵 ——
    // 输出退化为重复词 / 闭合标签丢失。重试一次但不带字典请求：丢字典，保住翻译主路径。
    recordCombinedFailure(settings.model);
    console.warn('[Dualang] combined call parse failed, retrying without smartDict', {
      model: settings.model,
      failures: combinedFailures.get(settings.model || ''),
      rawPreview: raw.slice(0, 200),
    });
    const retried = await doTranslateBatchRequest(
      texts, settings, signal, maxRetries, strictMode, { /* 去掉 smartDictIndices */ },
    );
    return retried;
  }
  const translations = parseDelimitedBatch(raw, texts.length, tagOffset);
  const successCount = translations.filter((t) => t && t.length > 0).length;
  if (successCount === 0) {
    throw new Error(`批量翻译解析失败（未找到 <tN> 标签或 ===N=== 分隔符）: ${raw.slice(0, 200)}`);
  }
  return { translations, usage: data.usage };
}

/** 去掉 markdown 代码块壳，若无则原样返回 */
function stripMarkdownCode(s: string): string {
  const match = s.match(/```(?:[a-zA-Z]+)?\s*([\s\S]*?)```/);
  return match ? match[1].trim() : s.trim();
}
