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

  it('GLM 非 4.6 系列命中 glm-legacy（GLM-4-9B / 4-32B / 4-Plus）', () => {
    // 顺序：GLM46 先命中 4.6，其他 glm-4 落到 legacy
    expect(getProfile({ model: 'THUDM/GLM-4-9B-0414' }).id).toBe('glm-legacy');
    expect(getProfile({ baseUrl: 'https://api.siliconflow.cn/v1', model: 'THUDM/GLM-4-32B-0414' }).id).toBe('glm-legacy');
    // legacy 禁流式，避免 CJK SSE 切字
    expect(getProfile({ model: 'THUDM/GLM-4-9B-0414' }).supportsStreaming).toBe(false);
    // 4.6 还是启用流式
    expect(getProfile({ model: 'glm-4.6' }).supportsStreaming).toBe(true);
  });

  it('Generic fallback: 未匹配到任何 profile，默认禁流式', () => {
    expect(getProfile({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4' }).id).toBe('generic-openai');
    expect(getProfile({ baseUrl: 'https://unknown.example.com/v1', model: 'weird-model' }).id).toBe('generic-openai');
    // generic 默认禁流式：未知 endpoint 小模型普遍有 SSE 切 CJK 字符问题
    expect(getProfile({ model: 'gpt-4' }).supportsStreaming).toBe(false);
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

  // ===================== 顺序敏感性防御 =====================
  // PROFILES 数组内部顺序对正确性是 load-bearing 的：
  //   - QWEN3 必须在 QWEN_LEGACY 之前，否则 /qwen/i 会先命中把 qwen3 也吞掉
  //   - GLM46 必须在 GLM_LEGACY 之前，否则 /glm-4/i 会先命中把 4.6 也吞掉
  //   - MOONSHOT 用 baseUrl 匹配，和 model 无关，任意位置都行
  // 这些单测不是给"新模型"加覆盖的，是保护现有顺序不被重排破坏。
  describe('profile 匹配顺序（重排即回归）', () => {
    it('Qwen3 不能被 Qwen legacy /qwen/i 吞掉', () => {
      expect(getProfile({ model: 'Qwen/Qwen3-8B' }).id).toBe('qwen3');
      expect(getProfile({ model: 'qwen3-72b' }).id).toBe('qwen3');
      expect(getProfile({ model: 'QwQ-32B-Preview' }).id).toBe('qwen3');
    });

    it('Qwen2.5 / 1.5 / 无版本号都落到 qwen-legacy', () => {
      expect(getProfile({ model: 'Qwen/Qwen2.5-7B-Instruct' }).id).toBe('qwen-legacy');
      expect(getProfile({ model: 'Qwen/Qwen1.5-7B' }).id).toBe('qwen-legacy');
      expect(getProfile({ model: 'qwen-7b-chat' }).id).toBe('qwen-legacy');
    });

    it('GLM 4.6 不能被 glm-legacy /glm-4/i 吞掉', () => {
      expect(getProfile({ model: 'glm-4.6' }).id).toBe('glm-4.6');
      expect(getProfile({ model: 'glm-4-6' }).id).toBe('glm-4.6');
      expect(getProfile({ model: 'GLM-4.6' }).id).toBe('glm-4.6');
    });

    it('GLM 4.0-5.x 范围都落 glm-legacy（仅 4.6 走 46 profile）', () => {
      expect(getProfile({ model: 'THUDM/GLM-4-9B-0414' }).id).toBe('glm-legacy');
      expect(getProfile({ model: 'GLM-4-Plus' }).id).toBe('glm-legacy');
      expect(getProfile({ model: 'glm-4-32b' }).id).toBe('glm-legacy');
    });

    it('Moonshot baseUrl 匹配优先于 generic fallback', () => {
      // 即使 model 名看起来像 generic
      expect(getProfile({ baseUrl: 'https://api.moonshot.cn/v1', model: 'gpt-4' }).id).toBe('moonshot');
    });

    it('thinkingControl 通过 profile 间接暴露顺序错乱', () => {
      // 如果 QWEN_LEGACY 抢先命中 Qwen3，thinkingControl 会变成 'omit'（错）
      expect(getProfile({ model: 'Qwen/Qwen3-8B' }).thinkingControl).toBe('enable-thinking-false');
      // 如果 GLM_LEGACY 抢先命中 GLM-4.6，thinkingControl 会变成 'omit'（错）
      expect(getProfile({ model: 'glm-4.6' }).thinkingControl).toBe('thinking-disabled');
    });
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
