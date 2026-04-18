import { describe, it, expect } from 'vitest';
import { getProfile, resolveEndpoint, parseDelimitedBatch, composeSystemPrompt } from './profiles';

describe('getProfile', () => {
  it('Moonshot: baseUrl 命中', () => {
    expect(getProfile({ baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2.5' }).id).toBe('moonshot');
    expect(getProfile({ baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' }).id).toBe('moonshot');
  });

  it('Qwen3 / QwQ: 命中 qwen3 profile（enable_thinking 控制）', () => {
    expect(getProfile({ baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen3-8B' }).id).toBe('qwen3');
    expect(getProfile({ model: 'Qwen/QwQ-32B-Preview' }).id).toBe('qwen3');
  });

  it('Qwen 旧版（Qwen2.5 / Qwen1.5 / Pro 通道）: 命中 qwen-legacy（不传 thinking 字段）', () => {
    expect(getProfile({ baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' }).id).toBe('qwen-legacy');
    expect(getProfile({ model: 'Pro/Qwen/Qwen2.5-7B-Instruct' }).id).toBe('qwen-legacy');
    expect(getProfile({ model: 'qwen-7b-chat' }).id).toBe('qwen-legacy');
  });

  it('GLM-4.6: 模型名正则命中（支持 glm-4.6 / glm-4-6）', () => {
    expect(getProfile({ baseUrl: 'https://api.z.ai/v1', model: 'glm-4.6' }).id).toBe('glm-4.6');
    expect(getProfile({ baseUrl: 'https://api.z.ai/v1', model: 'GLM-4-6' }).id).toBe('glm-4.6');
  });

  it('Generic fallback: 未匹配到任何 profile', () => {
    expect(getProfile({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4' }).id).toBe('generic-openai');
    expect(getProfile({ baseUrl: 'https://unknown.example.com/v1', model: 'weird-model' }).id).toBe('generic-openai');
    // GLM-4-9B 走 generic（不是 glm-4.6）
    expect(getProfile({ baseUrl: 'https://api.siliconflow.cn/v1', model: 'THUDM/GLM-4-9B-0414' }).id).toBe('generic-openai');
  });

  it('温度按模型分流：kimi-k2.5 → 1，其他 Moonshot → 0.3', () => {
    const p = getProfile({ baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2.5' });
    expect(p.temperature({ model: 'kimi-k2.5' })).toBe(1);
    expect(p.temperature({ model: 'moonshot-v1-8k' })).toBe(0.3);
  });

  it('温度：Qwen2.5 用 0.1（避免退化循环），Qwen3 / GLM-4.6 / Generic 用 0.3', () => {
    // Qwen2.5 在 T >= 0.3 时约 30% 概率陷入 "on on" 退化循环（v2 bench 实测）
    expect(getProfile({ model: 'Qwen/Qwen2.5-7B-Instruct' }).temperature({ model: 'Qwen/Qwen2.5-7B-Instruct' })).toBe(0.1);
    expect(getProfile({ model: 'Qwen/Qwen3-8B' }).temperature({ model: 'Qwen/Qwen3-8B' })).toBe(0.3);
    expect(getProfile({ model: 'glm-4.6' }).temperature({ model: 'glm-4.6' })).toBe(0.3);
    expect(getProfile({ model: 'gpt-4' }).temperature({ model: 'gpt-4' })).toBe(0.3);
  });

  it('thinkingControl 分流：Qwen2.5 不传 thinking（v2 bench 实测误传会退化成 on-loop）', () => {
    expect(getProfile({ baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2.5' }).thinkingControl).toBe('omit');
    expect(getProfile({ model: 'Qwen/Qwen2.5-7B-Instruct' }).thinkingControl).toBe('omit');     // 关键：2.5 不传
    expect(getProfile({ model: 'Qwen/Qwen3-8B' }).thinkingControl).toBe('enable-thinking-false'); // 3 才传
    expect(getProfile({ model: 'glm-4.6' }).thinkingControl).toBe('thinking-disabled');
    expect(getProfile({ model: 'gpt-4' }).thinkingControl).toBe('omit');
  });

  it('prompt 模板含目标语言变量', () => {
    const p = getProfile({ model: 'kimi-k2.5' });
    expect(p.systemPromptSingle('简体中文')).toContain('简体中文');
    expect(p.systemPromptBatch('英语')).toContain('英语');
  });
});

describe('resolveEndpoint', () => {
  it('拼接 baseUrl + endpointPath，去掉尾部斜杠', () => {
    const p = getProfile({ model: 'kimi-k2.5' });
    expect(resolveEndpoint(p, 'https://api.moonshot.cn/v1')).toBe('https://api.moonshot.cn/v1/chat/completions');
    expect(resolveEndpoint(p, 'https://api.moonshot.cn/v1/')).toBe('https://api.moonshot.cn/v1/chat/completions');
  });
});

describe('parseDelimitedBatch', () => {
  it('标准格式：===0===/===1===', () => {
    const raw = '===0===\n译文A\n\n===1===\n译文B';
    expect(parseDelimitedBatch(raw, 2)).toEqual(['译文A', '译文B']);
  });

  it('单段多段混合', () => {
    const raw = '===0===\n第一段\n\n第二段\n\n===1===\n第二条';
    expect(parseDelimitedBatch(raw, 2)).toEqual(['第一段\n\n第二段', '第二条']);
  });

  it('前置噪声被忽略（模型偶发"好的，以下是翻译："）', () => {
    const raw = '好的，以下是翻译：\n\n===0===\n译文A\n\n===1===\n译文B';
    expect(parseDelimitedBatch(raw, 2)).toEqual(['译文A', '译文B']);
  });

  it('乱序/非连续 index 也能对齐', () => {
    // 模型先输出 1 再 0（罕见但可能）
    const raw = '===1===\nB\n\n===0===\nA';
    expect(parseDelimitedBatch(raw, 2)).toEqual(['A', 'B']);
  });

  it('超出 expectedCount 的 index 被忽略（防越界）', () => {
    const raw = '===0===\nA\n\n===5===\nX';
    expect(parseDelimitedBatch(raw, 2)).toEqual(['A', '']);
  });

  it('分隔符有内部空格也能识别（=== 0 ===）', () => {
    const raw = '=== 0 ===\nA\n\n=== 1 ===\nB';
    expect(parseDelimitedBatch(raw, 2)).toEqual(['A', 'B']);
  });

  it('完全没有分隔符 → 全是空串', () => {
    expect(parseDelimitedBatch('just plain text', 2)).toEqual(['', '']);
  });

  it('只有一个 ===N=== 也能取出对应 index 内容', () => {
    expect(parseDelimitedBatch('===0===\n只有一条', 3)).toEqual(['只有一条', '', '']);
  });

  it('降级：模型返回 JSON 时也能解析（兼容强模型 + 旧测试）', () => {
    const raw = '{"results":[{"index":0,"translated":"译文A"},{"index":1,"translated":"译文B"}]}';
    expect(parseDelimitedBatch(raw, 2)).toEqual(['译文A', '译文B']);
  });

  it('降级：JSON 被 markdown 代码块包住也能识别', () => {
    const raw = '```json\n{"results":[{"index":0,"translated":"A"}]}\n```';
    expect(parseDelimitedBatch(raw, 1)).toEqual(['A']);
  });
});

describe('composeSystemPrompt', () => {
  const p = getProfile({ model: 'kimi-k2.5' });

  it('单条非严格 → systemPromptSingle', () => {
    const got = composeSystemPrompt(p, '简体中文', { batch: false, strict: false });
    expect(got).not.toContain('===N===');
    expect(got).toContain('简体中文');
    expect(got).not.toContain('严格模式');
  });

  it('批量非严格 → systemPromptBatch，包含 ===N===', () => {
    const got = composeSystemPrompt(p, '简体中文', { batch: true, strict: false });
    expect(got).toContain('===N===');
    expect(got).not.toContain('严格模式');
  });

  it('批量严格 → STRICT_PREFIX 在前', () => {
    const got = composeSystemPrompt(p, '简体中文', { batch: true, strict: true });
    expect(got.startsWith('【严格模式必须遵守】')).toBe(true);
    expect(got).toContain('===N===');
  });

  it('单条严格 → STRICT_PREFIX 在前', () => {
    const got = composeSystemPrompt(p, '简体中文', { batch: false, strict: true });
    expect(got.startsWith('【严格模式必须遵守】')).toBe(true);
    expect(got).not.toContain('===N===');
  });
});
