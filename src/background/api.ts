import { reportFatalError, clearErrorState } from './error-report';
import { getProfile, resolveEndpoint, composeSystemPrompt, parseDelimitedBatch, LANG_DISPLAY, type ProviderProfile } from './profiles';
import { iterateSseDeltas } from './sse';
import type { Settings, TokenUsage } from '../shared/types';

// ===================== 思考模式控制 =====================
// 翻译任务不需要推理；关闭方式按 provider profile.thinkingControl 分发：
//   - 'omit':                      省略 reasoning_effort 即关闭（Moonshot / OpenAI 等）
//   - 'enable-thinking-false':     body.enable_thinking = false（Qwen 系列）
//   - 'thinking-disabled':         body.thinking = { type: 'disabled' }（GLM-4.6+）
// 具体哪个模型用哪条策略由 src/background/profiles.ts 登记。
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

  const systemPrompt = composeSystemPrompt(profile, targetLangDisplay, { batch: false, strict: strictMode });

  const body: any = {
    model: settings.model || 'kimi-k2.5',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text }
    ],
    temperature: profile.temperature(settings),
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

// ===================== 流式批量翻译（逐条推送）=====================

export type OnStreamResult = (index: number, translated: string) => void;

/**
 * 流式批量翻译：SSE stream + 增量 ===N=== 分隔符提取。
 * 当检测到下一条的 "===M===" 开头时，把上一条 [N..M) 之间的内容作为第 N 条的完成译文推送。
 * 最后一条在流结束时由 buffer 尾部推送。
 */
export async function doTranslateBatchStream(
  texts: string[],
  settings: Settings,
  signal: AbortSignal | null,
  onResult: OnStreamResult,
  strictMode = false,
): Promise<{ translations: string[] }> {
  const profile = getProfile(settings);
  const endpoint = resolveEndpoint(profile, settings.baseUrl || 'https://api.moonshot.cn/v1');
  const targetLangDisplay = LANG_DISPLAY[settings.targetLang] || settings.targetLang;

  const isSingle = texts.length === 1;
  const systemPrompt = composeSystemPrompt(profile, targetLangDisplay, {
    batch: !isSingle, strict: strictMode,
  });
  const userContent = isSingle
    ? texts[0]
    : texts.map((t, i) => `===${i}===\n${t}`).join('\n\n');

  const body: any = {
    model: settings.model || 'kimi-k2.5',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: profile.temperature(settings),
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

  function tryEmitCompleted() {
    if (isSingle) return;  // 单条不做增量推送
    // 找所有已出现的 "===N===" 分隔符位置；相邻分隔符之间的内容才算"完成"
    const re = /^===\s*(\d+)\s*===\s*$/gm;
    const positions: Array<{ idx: number; start: number; end: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(accumulated)) !== null) {
      const idx = parseInt(m[1], 10);
      if (Number.isFinite(idx)) {
        positions.push({ idx, start: m.index, end: m.index + m[0].length });
      }
    }
    // 只有当下一个分隔符已出现时，才能确定前一个分隔符对应的内容已完成
    for (let i = 0; i < positions.length - 1; i++) {
      const cur = positions[i];
      if (emittedIndices.has(cur.idx)) continue;
      if (cur.idx < 0 || cur.idx >= texts.length) continue;
      const content = accumulated.slice(cur.end, positions[i + 1].start).trim();
      if (content) {
        emittedIndices.add(cur.idx);
        onResult(cur.idx, content);
      }
    }
  }

  for await (const delta of iterateSseDeltas(response)) {
    accumulated += delta;
    tryEmitCompleted();
  }

  // 终局解析：单条纯文本 or 分隔符切分
  if (isSingle) {
    const content = stripMarkdownCode(accumulated.trim());
    if (!emittedIndices.has(0) && content) {
      onResult(0, content);
    }
    return { translations: [content] };
  }

  const translations = parseDelimitedBatch(accumulated, texts.length);
  // 补推流式未覆盖的条目（最后一条通常是流结束才完成）
  for (let i = 0; i < translations.length; i++) {
    if (translations[i] && !emittedIndices.has(i)) {
      emittedIndices.add(i);
      onResult(i, translations[i]);
    }
  }
  if (emittedIndices.size === 0) {
    throw new Error(`流式批量翻译分隔符解析失败，原始内容: ${accumulated.slice(0, 200)}`);
  }
  return { translations };
}

export async function doTranslateBatchRequest(
  texts: string[],
  settings: Settings,
  signal: AbortSignal | null,
  maxRetries = 3,
  strictMode = false,
) {
  const profile = getProfile(settings);
  const endpoint = resolveEndpoint(profile, settings.baseUrl || 'https://api.moonshot.cn/v1');
  const targetLangDisplay = LANG_DISPLAY[settings.targetLang] || settings.targetLang;

  // 单条 → 纯文本输出（零结构开销）；多条 → ===N=== 分隔符（小模型远比 JSON 可靠）
  const isSingle = texts.length === 1;
  const systemPrompt = composeSystemPrompt(profile, targetLangDisplay, {
    batch: !isSingle, strict: strictMode,
  });
  const userContent = isSingle
    ? texts[0]
    : texts.map((t, i) => `===${i}===\n${t}`).join('\n\n');

  const body: any = {
    model: settings.model || 'kimi-k2.5',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: profile.temperature(settings),
    stream: false,
  };

  const mt = maxTokensForBatch(settings, texts);
  if (mt !== undefined) body.max_tokens = mt;
  applyThinkingMode(body, settings, profile);

  const data = await callWithRetry(() => fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}` },
    body: JSON.stringify(body),
    signal: signal ?? undefined
  }).then(r => parseApiResponse(r, false)), maxRetries, settings);

  const raw = data.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error('API 返回结果为空');

  if (isSingle) {
    const cleaned = stripMarkdownCode(raw);
    // 通常是纯文本译文，但若模型忽略指令返回 JSON/分隔符（或 mock 测试如此），也兼容解析
    if (/^\s*[{[]/.test(cleaned) || /^===\s*\d+\s*===/m.test(cleaned)) {
      const fallback = parseDelimitedBatch(cleaned, 1);
      if (fallback[0]) return { translations: fallback, usage: data.usage };
    }
    return { translations: [cleaned], usage: data.usage };
  }

  // 多条：按 ===N=== 拆分
  const translations = parseDelimitedBatch(raw, texts.length);
  const successCount = translations.filter((t) => t && t.length > 0).length;
  if (successCount === 0) {
    throw new Error(`批量翻译解析失败（未找到 ===N=== 分隔符）: ${raw.slice(0, 200)}`);
  }
  return { translations, usage: data.usage };
}

/** 去掉 markdown 代码块壳，若无则原样返回 */
function stripMarkdownCode(s: string): string {
  const match = s.match(/```(?:[a-zA-Z]+)?\s*([\s\S]*?)```/);
  return match ? match[1].trim() : s.trim();
}
