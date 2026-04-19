/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initBubble, trackArticle, setBubbleState, disposeBubble } from './super-fine-bubble';

beforeEach(() => {
  document.body.innerHTML = '';
  disposeBubble();
});

describe('initBubble', () => {
  it('创建浮球 DOM 挂在 body，默认隐藏', () => {
    initBubble({ onTrigger: vi.fn(), onCancel: vi.fn() });
    const bubble = document.querySelector('.dualang-bubble');
    expect(bubble).toBeTruthy();
    expect(bubble?.classList.contains('dualang-bubble--hidden')).toBe(true);
  });
});

describe('trackArticle / setBubbleState', () => {
  it('跟踪 article 时浮球显现为 idle 状态', () => {
    const onTrigger = vi.fn();
    initBubble({ onTrigger, onCancel: vi.fn() });
    const article = document.createElement('article');
    article.setAttribute('data-dualang-article-id', 'a1');
    document.body.appendChild(article);
    trackArticle(article);
    const bubble = document.querySelector('.dualang-bubble')!;
    expect(bubble.classList.contains('dualang-bubble--hidden')).toBe(false);
    expect(bubble.classList.contains('dualang-bubble--idle')).toBe(true);
  });

  it('setBubbleState translating 携带进度更新圆环', () => {
    initBubble({ onTrigger: vi.fn(), onCancel: vi.fn() });
    const article = document.createElement('article');
    article.setAttribute('data-dualang-article-id', 'a1');
    document.body.appendChild(article);
    trackArticle(article);
    setBubbleState('a1', 'translating', { completed: 5, total: 20 });
    const bubble = document.querySelector('.dualang-bubble')!;
    expect(bubble.classList.contains('dualang-bubble--translating')).toBe(true);
    const ring = bubble.querySelector('.dualang-bubble-ring') as SVGCircleElement;
    expect(ring.getAttribute('data-progress')).toBe('0.25');
  });

  it('点击 idle 浮球触发 onTrigger 回调', () => {
    const onTrigger = vi.fn();
    initBubble({ onTrigger, onCancel: vi.fn() });
    const article = document.createElement('article');
    article.setAttribute('data-dualang-article-id', 'a1');
    document.body.appendChild(article);
    trackArticle(article);
    const bubble = document.querySelector('.dualang-bubble') as HTMLElement;
    bubble.click();
    expect(onTrigger).toHaveBeenCalledWith('a1');
  });
});
