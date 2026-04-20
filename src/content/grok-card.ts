/**
 * Grok 摘要卡识别：X.com trending/热点的 Grok AI 总结卡没有 testid/role/aria-label 可用。
 * 识别策略用"结构 + 语义"两类信号组合：
 *
 *   - 必选：disclaimer 短语（多语言）——这是卡的本质特征，X.com 改版也大概率保留
 *   - 辅助：结构（4 个 div 子）、<time> 存在、容器 aria-label 提示 "grok|trending"
 *
 * disclaimer 命中且至少一个辅助信号就认；即便 X.com 把 4 个 div 变成 3 个或插入
 * SVG 图标节点，只要免责声明还在就不至于完全识别失败。
 */

// 多语言免责声明前缀（所有已知 locale）；通过 startsWith 容忍后续文案变化
export const GROK_DISCLAIMER_PREFIXES = [
  'This story is a summary of posts on X',  // en
  '此新闻是 X 上帖子的摘要',                   // zh-CN
  '此新聞是 X 上貼文的摘要',                   // zh-TW
];

function hasGrokDisclaimer(el: Element): boolean {
  const text = (el.textContent || '').trim();
  return GROK_DISCLAIMER_PREFIXES.some((p) => text.startsWith(p));
}

function isGrokCardContainer(el: Element): boolean {
  if (!(el instanceof Element)) return false;
  // 必选：最后一个子节点以 disclaimer 开头（整树 textContent 包含不够 —— 祖先会把
  // 整段文字拢进 textContent 但 disclaimer 不在其子首）
  const lastChild = el.children[el.children.length - 1];
  if (!lastChild || !hasGrokDisclaimer(lastChild)) return false;

  // 至少命中一个辅助信号，排除偶发的包含 disclaimer 文本的无关容器
  let signals = 0;
  if (el.children.length === 4) signals++;
  if (el.querySelector('time')) signals++;
  const aria = el.getAttribute('aria-label') || '';
  if (/grok|trending|热点|趨勢/i.test(aria)) signals++;
  return signals >= 1;
}

/**
 * 在 root 子树里找所有未处理的 Grok 卡，打上标记后返回（idempotent）。
 * - 卡容器自身标 `data-dualang-grok="true"`
 * - 正文元素（children[2] 内层的 div[dir]）标 `data-dualang-text="true"`
 *   供 findTweetTextEl 统一识别
 */
export function findAndPrepareGrokCards(root: Element | Document): Element[] {
  const scope: any = root instanceof Element ? root : document;
  // 候选集：用 `:has(time)` 先粗筛；浏览器不支持时全量 div 兜底
  let candidates: Element[] = [];
  try {
    candidates = Array.from(scope.querySelectorAll('div:has(> time), div:has(time)'));
  } catch (_) {
    candidates = Array.from(scope.querySelectorAll('div'));
  }
  const cards: Element[] = [];
  for (const el of candidates) {
    // 从候选往上找到 "disclaimer + 辅助信号" 的最小容器
    let node: Element | null = el;
    for (let i = 0; i < 6 && node; i++) {
      if (isGrokCardContainer(node)) {
        if (!node.hasAttribute('data-dualang-grok')) {
          // children[2] 是正文 wrapper，内层的 div[dir] 是真正文本元素
          const bodyWrapper = node.children[2];
          const bodyEl = bodyWrapper?.querySelector('div[dir]') || bodyWrapper?.querySelector('div');
          if (bodyEl) {
            node.setAttribute('data-dualang-grok', 'true');
            bodyEl.setAttribute('data-dualang-text', 'true');
            cards.push(node);
          }
        }
        break;
      }
      node = node.parentElement;
    }
  }
  return cards;
}
