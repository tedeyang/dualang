# ADR: Qwen2.5 / 旧版 Qwen 系列温度与流式选择

**Status**: Accepted (from v2 benchmark, 2026-04)

## Context

`QWEN_LEGACY_PROFILE` 覆盖 Qwen2.5 / Qwen1.5 / 无版本号 Qwen（按 `/qwen/i` 正则、且 QWEN3_PROFILE 之后匹配）系列模型。这些模型和新 Qwen3 / QwQ 在推理参数、流式稳定性上有显著差异，不能共用同一 profile。

## Decisions

### temperature = 0.1（而非 Moonshot / Qwen3 默认的 0.3）

v2 bench 在 280+ 字符推文上实测：
- **T = 0.3**：约 30% 概率陷入 `"on on on on ..."` 退化循环，输出膨胀直到打爆 `max_tokens`（4422 tokens）
- **T = 0.7 / 1.0**：稳定性更差，还有额外的数字幻觉（`"2028 年" → "208 年"`）
- **T = 0.1**：几乎不出现退化；长文本稳定；数字错误率显著下降

0.1 是唯一能在长输入上稳定工作的温度；牺牲的创造性对翻译任务无感。

### thinkingControl = 'omit'（不传 `enable_thinking`）

旧 Qwen 不支持 `enable_thinking` 参数。误传两种后果：
- 某些部署返回 400
- 某些部署接受但进入 reasoning 模式，输出 `"on on on"` 退化 token 当作翻译

Qwen3 / QwQ 才走 `'enable-thinking-false'` 显式关闭；旧 Qwen 通过省略该字段自然关闭。

### supportsStreaming = false

Qwen2.5-7B（SiliconFlow 托管）在 CJK 翻译下的 SSE 分片偶发在多字节 UTF-8 字符边界切断，服务端下发的 chunk 就带有 `U+FFFD`。现象：零星的"�"混入译文。

禁用流式、走 `response.json()` 整包解码后该现象消失。

## 影响其他代码路径

- `profiles.ts` 匹配顺序：`QWEN3_PROFILE` 必须在 `QWEN_LEGACY_PROFILE` 之前，否则 `/qwen/i` 会先命中把 qwen3 也吞进 legacy（有 `profiles.test.ts` 顺序敏感单测守护）
- 超级精翻（`handleSuperFineStream`）默认走 GLM 而非 Qwen，部分原因也是 Qwen legacy 禁流式，精翻的 SSE 渐进体验无法走这条链路

## 参考

`profiles.ts:QWEN_LEGACY_PROFILE`、`profiles.test.ts` 温度/thinkingControl 单测。
