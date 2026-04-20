/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initBubble, setLongArticle, setBubbleState, disposeBubble, bindSuperFineArticle } from './super-fine-bubble';

// chrome API mock：浮球初始化会调 storage.sync.get / onChanged / sendMessage
beforeEach(() => {
  (globalThis as any).chrome = {
    runtime: {
      sendMessage: vi.fn().mockResolvedValue({ success: true, data: {} }),
      getURL: (p: string) => `chrome-extension://fake/${p}`,
    },
    storage: {
      sync: {
        get: vi.fn().mockResolvedValue({
          enabled: true,
          displayMode: 'append',
          bilingualMode: false,
          baseUrl: 'https://api.siliconflow.cn/v1',
          model: 'THUDM/GLM-4-9B-0414',
        }),
        set: vi.fn().mockResolvedValue(undefined),
      },
      onChanged: { addListener: vi.fn() },
    },
  };
  document.body.innerHTML = '';
  disposeBubble();
});

afterEach(() => {
  disposeBubble();
});

describe('initBubble', () => {
  it('创建浮球 DOM 挂在 body，始终可见（非 article-scoped）', () => {
    initBubble();
    const bubble = document.querySelector('.dualang-bubble');
    expect(bubble).toBeTruthy();
    // 重构后：浮球不再随 article 出现/消失，默认 idle class
    expect(bubble?.classList.contains('dualang-bubble--idle')).toBe(true);
  });

  it('创建面板的 4 个区块：开关、显示、对照风格、模型列表', () => {
    initBubble();
    const panel = document.querySelector('.dualang-bubble-panel')!;
    expect(panel.querySelector('[data-field="enabled"]')).toBeTruthy();
    expect(panel.querySelector('[data-section="display"]')).toBeTruthy();
    expect(panel.querySelector('[data-section="style"]')).toBeTruthy();
    expect(panel.querySelector('[data-section="models"]')).toBeTruthy();
  });
});

describe('setBubbleState', () => {
  it('translating + 进度更新圆环 data-progress', () => {
    initBubble();
    setBubbleState('ignored-id', 'translating', { completed: 5, total: 20 });
    const bubble = document.querySelector('.dualang-bubble')!;
    expect(bubble.classList.contains('dualang-bubble--translating')).toBe(true);
    const ring = bubble.querySelector('.dualang-bubble-ring') as SVGCircleElement;
    expect(ring.getAttribute('data-progress')).toBe('0.25');
  });

  it('done 状态设置 --progress=1，CSS 控制配色', () => {
    initBubble();
    setBubbleState('ignored-id', 'done');
    const bubble = document.querySelector('.dualang-bubble') as HTMLElement;
    expect(bubble.classList.contains('dualang-bubble--done')).toBe(true);
    expect(bubble.style.getPropertyValue('--progress')).toBe('1');
  });

  it('failed 状态加 failed class', () => {
    initBubble();
    setBubbleState('ignored-id', 'failed');
    const bubble = document.querySelector('.dualang-bubble') as HTMLElement;
    expect(bubble.classList.contains('dualang-bubble--failed')).toBe(true);
  });
});

describe('drag Y-axis', () => {
  it('pointer 拖动更新 top 位置并 clamp 到 viewport', () => {
    initBubble();
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
    initBubble();
    const bubble = document.querySelector('.dualang-bubble') as HTMLElement;
    bubble.dispatchEvent(new PointerEvent('pointerdown', { clientY: 400, pointerId: 1 }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientY: 500, pointerId: 1 }));
    document.dispatchEvent(new PointerEvent('pointerup', { clientY: 500, pointerId: 1 }));
    expect(setSpy).toHaveBeenCalledWith('dualang.bubble.top', expect.any(String));
    setSpy.mockRestore();
  });

  it('初始化时读取 localStorage 中的 top', () => {
    localStorage.setItem('dualang.bubble.top', '250');
    initBubble();
    const bubble = document.querySelector('.dualang-bubble') as HTMLElement;
    expect(bubble.style.top).toBe('250px');
    localStorage.removeItem('dualang.bubble.top');
  });
});

describe('hover panel', () => {
  it('hover 浮球显示 panel，mouseleave 隐藏', () => {
    initBubble();
    const bubble = document.querySelector('.dualang-bubble') as HTMLElement;
    const panel = document.querySelector('.dualang-bubble-panel')!;
    bubble.dispatchEvent(new PointerEvent('pointerenter'));
    expect(panel.classList.contains('dualang-bubble-panel--visible')).toBe(true);
  });
});

describe('long article super-fine button', () => {
  it('setLongArticle → 面板里 super-fine section 显示', async () => {
    initBubble();
    const bubble = document.querySelector('.dualang-bubble') as HTMLElement;
    bubble.dispatchEvent(new PointerEvent('pointerenter'));
    const article = document.createElement('article');
    document.body.appendChild(article);
    setLongArticle(article);
    const sfSection = document.querySelector<HTMLElement>('[data-section="super-fine"]');
    expect(sfSection?.hidden).toBe(false);
  });

  it('setLongArticle(null) → super-fine section 隐藏', () => {
    initBubble();
    setLongArticle(document.createElement('article'));
    setLongArticle(null);
    const sfSection = document.querySelector<HTMLElement>('[data-section="super-fine"]');
    expect(sfSection?.hidden).toBe(true);
  });

  it('点击精翻按钮触发 onSuperFineTrigger 回调，参数是 article', () => {
    const onTrigger = vi.fn();
    initBubble({ onSuperFineTrigger: onTrigger });
    const bubble = document.querySelector('.dualang-bubble') as HTMLElement;
    bubble.dispatchEvent(new PointerEvent('pointerenter'));
    const article = document.createElement('article');
    document.body.appendChild(article);
    setLongArticle(article);
    const btn = document.querySelector<HTMLButtonElement>('[data-action="super-fine"]')!;
    btn.click();
    expect(onTrigger).toHaveBeenCalledWith(article);
  });

  it('精翻中时显示取消按钮，点击触发 onSuperFineCancel', () => {
    const onCancel = vi.fn();
    initBubble({ onSuperFineCancel: onCancel });
    const article = document.createElement('article');
    document.body.appendChild(article);
    setLongArticle(article);
    bindSuperFineArticle(article);
    setBubbleState('x', 'translating', { completed: 1, total: 5 });
    const bubble = document.querySelector('.dualang-bubble') as HTMLElement;
    bubble.dispatchEvent(new PointerEvent('pointerenter'));
    const cancelBtn = document.querySelector<HTMLButtonElement>('[data-action="super-fine-cancel"]')!;
    expect(cancelBtn.hidden).toBe(false);
    cancelBtn.click();
    expect(onCancel).toHaveBeenCalledWith(article);
  });
});

describe('model list', () => {
  it('渲染 MODEL_PRESETS 里的所有模型行', async () => {
    initBubble();
    // 等 loadSettingsFromStorage 的 async 初始化完成后 refreshPanel 才会填充列表
    await new Promise((r) => setTimeout(r, 20));
    const rows = document.querySelectorAll('.dualang-bubble-model-row');
    expect(rows.length).toBeGreaterThanOrEqual(5);  // 至少 5 个 preset
  });

  it('当前 baseUrl+model 对应的 preset 被标 active', async () => {
    initBubble();
    await new Promise((r) => setTimeout(r, 20));
    const active = document.querySelector('.dualang-bubble-model-row--active');
    expect(active).toBeTruthy();
  });
});
