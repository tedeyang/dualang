# ADR: GLM-4 非 4.6 系列禁用流式

**Status**: Accepted (2026-04)

## Context

`GLM_LEGACY_PROFILE` 覆盖 `THUDM/GLM-4-9B-0414` / `GLM-4-32B-0414` / `GLM-4-Plus` 等非 4.6 系列 GLM 模型（z.ai 原生 API 和 SiliconFlow 托管路径都有）。

## Decision

`supportsStreaming = false`。

### 症状

旧 GLM-4 系列的 SSE 流式下发和 Qwen2.5 一样，在 CJK 翻译场景下有两类字符级损坏：

1. **`U+FFFD` 乱码**：多字节 UTF-8 字符在 SSE chunk 边界被切断，服务端下发的 data 行里就含 `�`
2. **字符复读**："， ， ，" / "就 不 就不应该" 这类空格分隔的重复 token；原因推测是服务端在 chunk 边界做了不完整的 tokenization 回放

两种症状叠加时可能整段译文不可用。

### 禁流式后

走 `response.json()` 整包解码，问题消失。付出代价：失去"第一段就渲染"的渐进体验；但整体 RTT 没有显著劣化（9B 模型本身就快）。

## 例外

- `GLM46_PROFILE`（`glm-4.6` / `glm-4-6`）**保留流式**：4.6 是新架构，上述问题未复现
- 顺序敏感：`GLM46_PROFILE` 必须在 `GLM_LEGACY_PROFILE` 之前匹配，否则 `/glm-4/i` 会把 4.6 一起吞掉（有 `profiles.test.ts` 单测守护）

## 影响其他代码路径

- 超级精翻（`handleSuperFineStream`）默认用 GLM-4-9B，但这里我们**主动复用 batch profile 的流式能力**（profile 的 `supportsStreaming: false` 在精翻路径里被 `enableStreaming: true` 覆盖，因为精翻需要渐进推送才能实现"边翻边看"）。这个例外是经过权衡的 —— 精翻场景一次只翻一段，损坏概率比批量小，可以接受偶发 `U+FFFD`

## 参考

`profiles.ts:GLM_LEGACY_PROFILE`、`GLM46_PROFILE` 对比；`api.ts:iterateSseDeltas` / `sse.ts` 里的 decoder flush 是所有流式路径共用的纠错兜底。
