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

describe('drag Y-axis', () => {
  it('pointer 拖动更新 top 位置并 clamp 到 viewport', () => {
    initBubble({ onTrigger: vi.fn(), onCancel: vi.fn() });
    const article = document.createElement('article');
    article.setAttribute('data-dualang-article-id', 'a1');
    document.body.appendChild(article);
    trackArticle(article);
    const bubble = document.querySelector('.dualang-bubble') as HTMLElement;
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });

    bubble.dispatchEvent(new PointerEvent('pointerdown', { clientY: 400, pointerId: 1 }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientY: 500, pointerId: 1 }));
    document.dispatchEvent(new PointerEvent('pointerup', { clientY: 500, pointerId: 1 }));
    expect(bubble.style.top).toMatch(/px$/);
    const top = parseFloat(bubble.style.top);
    expect(top).toBeGreaterThan(440);
    expect(top).toBeLessThan(520);
  });

  it('拖动后位置持久化到 localStorage', () => {
    const setSpy = vi.spyOn(Storage.prototype, 'setItem');
    initBubble({ onTrigger: vi.fn(), onCancel: vi.fn() });
    const article = document.createElement('article');
    article.setAttribute('data-dualang-article-id', 'a1');
    document.body.appendChild(article);
    trackArticle(article);
    const bubble = document.querySelector('.dualang-bubble') as HTMLElement;
    bubble.dispatchEvent(new PointerEvent('pointerdown', { clientY: 400, pointerId: 1 }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientY: 500, pointerId: 1 }));
    document.dispatchEvent(new PointerEvent('pointerup', { clientY: 500, pointerId: 1 }));
    expect(setSpy).toHaveBeenCalledWith('dualang.bubble.top', expect.any(String));
    setSpy.mockRestore();
  });

  it('初始化时读取 localStorage 中的 top', () => {
    localStorage.setItem('dualang.bubble.top', '250');
    initBubble({ onTrigger: vi.fn(), onCancel: vi.fn() });
    const bubble = document.querySelector('.dualang-bubble') as HTMLElement;
    expect(bubble.style.top).toBe('250px');
    localStorage.removeItem('dualang.bubble.top');
  });
});

describe('hover mini panel', () => {
  it('hover 浮球显示 panel，mouseleave 隐藏', () => {
    initBubble({ onTrigger: vi.fn(), onCancel: vi.fn() });
    const article = document.createElement('article');
    article.setAttribute('data-dualang-article-id', 'a1');
    document.body.appendChild(article);
    trackArticle(article);
    const bubble = document.querySelector('.dualang-bubble') as HTMLElement;
    bubble.dispatchEvent(new PointerEvent('pointerenter'));
    const panel = document.querySelector('.dualang-bubble-panel');
    expect(panel).toBeTruthy();
    expect(panel?.classList.contains('dualang-bubble-panel--visible')).toBe(true);
  });

  it('translating 状态面板 cancel 按钮触发 onCancel', () => {
    const onCancel = vi.fn();
    initBubble({ onTrigger: vi.fn(), onCancel });
    const article = document.createElement('article');
    article.setAttribute('data-dualang-article-id', 'a1');
    document.body.appendChild(article);
    trackArticle(article);
    setBubbleState('a1', 'translating', { completed: 2, total: 10 });
    const bubble = document.querySelector('.dualang-bubble') as HTMLElement;
    bubble.dispatchEvent(new PointerEvent('pointerenter'));
    const cancelBtn = document.querySelector('.dualang-bubble-panel-cancel') as HTMLElement;
    expect(cancelBtn).toBeTruthy();
    cancelBtn.click();
    expect(onCancel).toHaveBeenCalledWith('a1');
  });

  it('translating 状态面板显示进度文本 "N/M"', () => {
    initBubble({ onTrigger: vi.fn(), onCancel: vi.fn() });
    const article = document.createElement('article');
    article.setAttribute('data-dualang-article-id', 'a1');
    document.body.appendChild(article);
    trackArticle(article);
    setBubbleState('a1', 'translating', { completed: 3, total: 10 });
    const bubble = document.querySelector('.dualang-bubble') as HTMLElement;
    bubble.dispatchEvent(new PointerEvent('pointerenter'));
    const summary = document.querySelector('.dualang-bubble-panel-summary');
    expect(summary?.textContent).toContain('3/10');
  });
});
