import { describe, it, expect, vi } from 'vitest';

// Mock chrome-dependent modules before importing api.ts
vi.mock('./error-report', () => ({ reportFatalError: vi.fn(), clearErrorState: vi.fn() }));

const { classifyApiError, applyThinkingMode, computeMaxTokens } = await import('./api');

describe('classifyApiError', () => {
  // 429 variants
  it('429 exceeded_current_quota_error → 不可重试', () => {
    const body = JSON.stringify({ error: { type: 'exceeded_current_quota_error', message: 'quota exceeded' } });
    const result = classifyApiError(429, body);
    expect(result.retryable).toBe(false);
    expect(result.message).toContain('账户额度');
  });

  it('429 engine_overloaded_error → 可重试, retryAfter=5', () => {
    const body = JSON.stringify({ error: { type: 'engine_overloaded_error', message: 'overloaded' } });
    const result = classifyApiError(429, body);
    expect(result.retryable).toBe(true);
    expect(result.retryAfter).toBe(5);
  });

  it('429 rate_limit_reached_error → 解析 retry-after 秒数', () => {
    const body = JSON.stringify({ error: { type: 'rate_limit_reached_error', message: 'Please retry after 30 seconds' } });
    const result = classifyApiError(429, body);
    expect(result.retryable).toBe(true);
    expect(result.retryAfter).toBe(30);
  });

  it('429 rate_limit_reached_error 无秒数 → 默认 10s', () => {
    const body = JSON.stringify({ error: { type: 'rate_limit_reached_error', message: 'rate limited' } });
    const result = classifyApiError(429, body);
    expect(result.retryAfter).toBe(10);
  });

  // 400 variants
  it('400 content_filter → 不可重试', () => {
    const body = JSON.stringify({ error: { type: 'content_filter', message: 'blocked' } });
    const result = classifyApiError(400, body);
    expect(result.retryable).toBe(false);
    expect(result.message).toContain('内容审查');
  });

  it('400 token too long → 不可重试', () => {
    const body = JSON.stringify({ error: { type: 'invalid_request', message: 'token length too long' } });
    const result = classifyApiError(400, body);
    expect(result.retryable).toBe(false);
    expect(result.message).toContain('token 限制');
  });

  it('400 其他 → 不可重试，包含原始消息', () => {
    const body = JSON.stringify({ error: { type: 'bad_request', message: 'invalid model' } });
    const result = classifyApiError(400, body);
    expect(result.retryable).toBe(false);
    expect(result.message).toContain('invalid model');
  });

  // Auth errors
  it('401 → 不可重试, API Key 提示', () => {
    const result = classifyApiError(401, 'Unauthorized');
    expect(result.retryable).toBe(false);
    expect(result.message).toContain('API Key');
  });

  it('403 → 不可重试', () => {
    const result = classifyApiError(403, 'Forbidden');
    expect(result.retryable).toBe(false);
  });

  it('404 → 不可重试', () => {
    const result = classifyApiError(404, 'Not Found');
    expect(result.retryable).toBe(false);
    expect(result.message).toContain('模型不存在');
  });

  // Server errors
  it('500 → 可重试', () => {
    const result = classifyApiError(500, 'Internal Server Error');
    expect(result.retryable).toBe(true);
    expect(result.retryAfter).toBe(3);
  });

  it('502 → 可重试', () => {
    const result = classifyApiError(502, 'Bad Gateway');
    expect(result.retryable).toBe(true);
  });

  it('503 → 可重试', () => {
    const result = classifyApiError(503, 'Service Unavailable');
    expect(result.retryable).toBe(true);
  });

  // Unknown status
  it('418 → 不可重试（非 5xx/429）', () => {
    const result = classifyApiError(418, "I'm a teapot");
    expect(result.retryable).toBe(false);
  });

  // Non-JSON body
  it('非 JSON body, 500 → 可重试, 使用固定格式', () => {
    const result = classifyApiError(500, 'plain text error');
    expect(result.retryable).toBe(true);
    expect(result.message).toContain('500');
  });

  it('非 JSON body, 非 5xx → 使用原始文本', () => {
    const result = classifyApiError(422, 'some weird error');
    expect(result.message).toContain('some weird error');
  });
});

describe('applyThinkingMode', () => {
  it('reasoningEffort=none + Qwen2.5 → 不传 enable_thinking（Qwen2.5 不支持该参数）', () => {
    const body: any = {};
    applyThinkingMode(body, { model: 'Qwen/Qwen2.5-7B-Instruct', reasoningEffort: 'none' });
    expect(body.enable_thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.thinking).toBeUndefined();
  });

  it('reasoningEffort=none + Qwen3 / QwQ → enable_thinking:false（Qwen3 才有 thinking 模式）', () => {
    const body1: any = {};
    applyThinkingMode(body1, { model: 'Qwen/Qwen3-8B', reasoningEffort: 'none' });
    expect(body1.enable_thinking).toBe(false);
    const body2: any = {};
    applyThinkingMode(body2, { model: 'Qwen/QwQ-32B', reasoningEffort: 'none' });
    expect(body2.enable_thinking).toBe(false);
  });

  it('reasoningEffort=none + GLM-4.6 模型 → thinking:{type:disabled}', () => {
    const body: any = {};
    applyThinkingMode(body, { model: 'glm-4.6', reasoningEffort: 'none' });
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('reasoningEffort=none + Moonshot Kimi → 无任何 thinking 字段（省略即关闭）', () => {
    const body: any = {};
    applyThinkingMode(body, { model: 'kimi-k2.5', reasoningEffort: 'none' });
    expect(body.enable_thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.thinking).toBeUndefined();
  });

  it('reasoningEffort=medium 时 → 直接设 reasoning_effort，忽略品牌特定字段', () => {
    const body: any = {};
    applyThinkingMode(body, { model: 'Qwen/Qwen3-8B', reasoningEffort: 'medium' });
    expect(body.reasoning_effort).toBe('medium');
    expect(body.enable_thinking).toBeUndefined();
  });

  it('reasoningEffort 为空 → 按 none 处理（Qwen3 塞 enable_thinking:false，Qwen2.5 什么都不塞）', () => {
    const b3: any = {};
    applyThinkingMode(b3, { model: 'Qwen/Qwen3-8B' });
    expect(b3.enable_thinking).toBe(false);
    const b25: any = {};
    applyThinkingMode(b25, { model: 'Qwen/Qwen2.5-7B-Instruct' });
    expect(b25.enable_thinking).toBeUndefined();
  });

  it('reasoningEffort 为空 + 未知模型 → 不塞任何字段', () => {
    const body: any = {};
    applyThinkingMode(body, { model: 'unknown-random-model' });
    expect(body.enable_thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.thinking).toBeUndefined();
  });
});

describe('computeMaxTokens', () => {
  it('默认（无 override）用 2048/条 保底', () => {
    // UI 已移除 maxTokens 字段；短输入 → floor=2048
    expect(computeMaxTokens({} as any, ['hi'])).toBe(2048);
    expect(computeMaxTokens({ maxTokens: 0 } as any, ['hello'])).toBe(2048);
    expect(computeMaxTokens({ maxTokens: 'abc' } as any, ['hello'])).toBe(2048);
  });

  it('短文本 × 多条：用 2048 × count 保底', () => {
    const s = {} as any;
    // 5 条 500 字 → estimated 1250+600=1850 < floor 2048×5=10240
    expect(computeMaxTokens(s, Array(5).fill('a'.repeat(500)))).toBe(10240);
  });

  it('长文本：estimate 超过 floor 时取 estimate（20k 字符 → 10120 tokens）', () => {
    const s = {} as any;
    // 1 条 20000 字 → estimated 10000+120=10120，floor 2048 → 10120
    expect(computeMaxTokens(s, ['a'.repeat(20_000)])).toBe(10120);
  });

  it('极长文本受 32k 硬上限夹住', () => {
    const s = {} as any;
    expect(computeMaxTokens(s, ['a'.repeat(100_000)])).toBe(32_000);
  });

  it('内部 override（super-fine moonshot 传 8192）仍生效', () => {
    const s = { maxTokens: 8192 } as any;
    // 5 条短文 → floor 8192×5=40960 被 32k 上限夹住
    expect(computeMaxTokens(s, Array(5).fill('a'.repeat(100)))).toBe(32_000);
    // 1 条 1k 字符 → estimated 620，override floor 8192 → 8192
    expect(computeMaxTokens(s, ['a'.repeat(1000)])).toBe(8192);
  });
});
