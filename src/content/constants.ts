// 集中管理 content script 的调参常量。
// 按子系统分组；改动时尽量一个 commit 只动一组，便于回滚定位。

// ===================== 翻译队列 / 并发 =====================
/** 一次 flushQueue 从 pendingQueue 摘出的上限。拆成 SUB_BATCH_SIZE 个并发子批。 */
export const BATCH_SIZE = 20;
/** 每个 API 调用打包的推文数；也是流式模式里单请求的 subBatch 上限。 */
export const SUB_BATCH_SIZE = 5;
/** 全局并发请求上限。达到上限后新请求排队，低优先级被抢占。 */
export const MAX_CONCURRENT = 5;

// ===================== 内容 ID → 翻译缓存 =====================
/** content 侧按 getContentId 索引的内存缓存上限（LRU 淘汰最旧一条）。 */
export const TRANSLATION_CACHE_MAX = 5000;
/** 缓存条目最长存活时间（毫秒）。超时条目按需失效，避免长会话把旧译文永远挂住。 */
export const TRANSLATION_CACHE_TTL_MS = 30 * 60 * 1000;

// ===================== 调度 / 去抖 =====================
/** 视口内推文的 flush 聚合窗口（毫秒）；非视口请求用 SCHEDULER_IDLE_DELAY_MS。 */
export const SCHEDULER_URGENT_DELAY_MS = 80;
/** 非视口请求的 flush 聚合窗口（毫秒）。 */
export const SCHEDULER_IDLE_DELAY_MS = 200;
/** 聚合窗口开始后的最长饿死时间。超过即使窗口未到期也立刻 flush。 */
export const SCHEDULER_MAX_AGGREGATE_MS = 800;

/** Show more / DOM 回收检测的静默窗口（毫秒）。mutation 停止这么久才触发处理。 */
export const SHOW_MORE_STABLE_MS = 80;

// ===================== 超时 =====================
/** 常规批量翻译 sendMessage 请求超时（毫秒）。 */
export const REQUEST_TIMEOUT_MS = 30_000;
/** 长文分段翻译单 chunk 超时（毫秒）。5 段 ~4k 字符输入时 GLM-4-9B 偶尔需要更久。 */
export const LONG_CHUNK_TIMEOUT_MS = 60_000;
/** 流式翻译端到端超时（毫秒）。 */
export const STREAM_TIMEOUT_MS = 30_000;
/** 超级精翻（长文浮球）整体超时（毫秒）。 */
export const SUPER_FINE_TIMEOUT_MS = 600_000;

// ===================== IntersectionObserver =====================
/** preload observer 的 rootMargin（上下各一屏）。数字会被拼成 '${N}px 0px ${N}px 0px'。 */
export const PRELOAD_MARGIN_PX_FALLBACK = 800;
