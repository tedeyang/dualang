/**
 * Article 级别的可变状态，外部挂在 WeakMap 里按 Element 检索。
 * 取代原本直接挂在 DOM 节点上的 `_dualang*` expandos：
 *   - 可序列化 / 可单测
 *   - X.com 虚拟 DOM 回收 article 时状态随之被 GC，不会残留给新租户
 *   - 集中类型定义，避免 scattered `(el as any)._dualangXxx` 散乱强转
 *
 * 访问语义：
 *   - `get(el)` —— 可能返回 undefined（该 article 从未被处理过）
 *   - `ensure(el)` —— 不存在则创建空状态后返回，用于需要"现在起开始追踪"的场景
 *   - 字段都是可选的；清理某个字段用 `delete state.field`，整条清理用 `clear(el)`
 */
export interface ArticleState {
  /** 该 article 入队等待翻译的时间（performance.now()） */
  enqueueTime?: number;
  /** 是否 viewport 内，决定是否可以被 preload-cancel 降级 */
  isHighPriority?: boolean;
  /** getContentId 快照，用于响应到达时判断 X.com 是否把 article 元素回收复用 */
  contentId?: string;
  /** 最近一次处理时 tweetText 的 textContent，用于精确检测内容变化 */
  lastText?: string;
  /** Show more / DOM 回收检测的去抖定时器 */
  showMoreTimer?: ReturnType<typeof setTimeout>;
  /** 质量重试额度（hasSuspiciousLineMismatch 触发）— 已用掉则不再重试防死循环 */
  qualityRetried?: boolean;
  /** 超级精翻（长文）当前占用的 port，用于用户点击取消时 disconnect */
  superFinePort?: chrome.runtime.Port;
}

const states = new WeakMap<Element, ArticleState>();

export function getState(el: Element): ArticleState | undefined {
  return states.get(el);
}

export function ensureState(el: Element): ArticleState {
  let s = states.get(el);
  if (!s) {
    s = {};
    states.set(el, s);
  }
  return s;
}

export function clearState(el: Element): void {
  states.delete(el);
}
