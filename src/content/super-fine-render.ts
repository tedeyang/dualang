import type { AnchoredBlock } from './utils';

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

export function fillSlot(article: Element, index: number, text: string): void {
  const slot = article.querySelector(`[data-dualang-slot-index="${index}"]`);
  if (!slot) return;
  slot.textContent = text;
  slot.classList.add('dualang-inline-translation--filled');
}

export function clearInlineSlots(article: Element): void {
  article.querySelectorAll('.dualang-inline-translation').forEach((n) => n.remove());
}
