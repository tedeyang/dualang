/**
 * 统一日志器 —— 跨 background / popup / content 共享。
 *
 * 设计：
 *   - 前缀统一 `[Dualang]`，第一个参数是 kebab / dot 命名的 event 字符串，
 *     第二个参数（可选）是结构化 data。DevTools Filter 里搜 `[Dualang]` 能一次看全部；
 *     搜 `[Dualang] router.select` 能只看路由决策。
 *   - 4 档 level：
 *       debug —— 极高频或噪音事件（每条推文的入队、每 delta 的 SSE chunk...）
 *                 默认在 Chrome DevTools 里隐藏（只有 Verbose filter 才显示）
 *       info  —— 正常业务进展（翻译请求、路由决策、配置变更）
 *       warn  —— 非致命异常（单条失败后的重试、熔断触发、回退到 fallback）
 *       error —— 用户可见的失败（两路都失败、API Key 失效）
 *   - event 名用小写 + 点分：`translate.request.ok`, `router.select`, `config.change.uiLang`
 *     方便 DevTools 过滤 + ops 聚合。
 *
 * content 侧的 telemetry 对象做 counters + summary，通过这个 logger 打印实际 console 输出 ——
 * 语义分工：telemetry 管计数，logger 管落盘。
 */

const PREFIX = '[Dualang]';

type Data = Record<string, unknown> | null | undefined;

function emit(
  fn: (...args: unknown[]) => void,
  event: string,
  data?: Data | unknown,
): void {
  if (data === undefined) fn(PREFIX, event);
  else fn(PREFIX, event, data);
}

export const log = {
  /** 高频 / 噪音事件 —— DevTools Verbose filter 才可见 */
  debug(event: string, data?: Data | unknown): void {
    emit(console.debug.bind(console), event, data);
  },
  /** 正常业务进展 */
  info(event: string, data?: Data | unknown): void {
    emit(console.log.bind(console), event, data);
  },
  /** 非致命异常（可恢复） */
  warn(event: string, data?: Data | unknown): void {
    emit(console.warn.bind(console), event, data);
  },
  /** 用户可见失败 */
  error(event: string, data?: Data | unknown): void {
    emit(console.error.bind(console), event, data);
  },
};
