import type { AnchoredBlock } from './utils';
import { linkifyText } from './render';

/**
 * 在长文 article 的每个原块（文本/图片 alt）后插入 skeleton slot。
 * slot 作为占位容器，精翻流式返回的译文逐段填入对应位置，不动原文 DOM。
 */
export function renderInlineSlots(article: Element, blocks: AnchoredBlock[]): void {
  clearInlineSlots(article);
  blocks.forEach((block, i) => {
    const slot = document.createElement('div');
    slot.className = 'dualang-inline-translation';
    if (block.kind === 'img-alt') slot.classList.add('dualang-inline-translation--img');
    slot.setAttribute('data-dualang-slot-index', String(i));
    block.el.parentNode?.insertBefore(slot, block.el.nextSibling);
  });
}

/** 将第 index 个 slot 填充为译文 text，并标记为已填充状态（触发 CSS 动画）。
 * 用 linkifyText 保留 URL 为可点击 <a> —— 精翻译文常常包含原文引用的 URL。
 */
export function fillSlot(article: Element, index: number, text: string): void {
  const slot = article.querySelector(`[data-dualang-slot-index="${index}"]`);
  if (!slot) return;
  while (slot.firstChild) slot.removeChild(slot.firstChild);
  slot.appendChild(linkifyText(text));
  slot.classList.add('dualang-inline-translation--filled');
}

/** 清除 article 下所有精翻 slot（通常在重新精翻或页面重置时调用）。 */
export function clearInlineSlots(article: Element): void {
  article.querySelectorAll('.dualang-inline-translation').forEach((n) => n.remove());
}
