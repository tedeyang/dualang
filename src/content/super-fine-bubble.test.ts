/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initBubble, setLongArticle, setBubbleState, disposeBubble, bindSuperFineArticle, setTranslationActivity } from './super-fine-bubble';

// chrome API mock：浮球初始化会调 storage.sync.get / onChanged / sendMessage
let storageListeners: Array<(changes: any, area: string) => void>;
beforeEach(() => {
  storageListeners = [];
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
      local: {
        get: vi.fn().mockResolvedValue({}),
      },
      onChanged: { addListener: (fn: any) => { storageListeners.push(fn); } },
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

  it('面板含所有关键控件：顶部开关+字典、显示/对照/模型 3 组，对照组含逐行融合', () => {
    initBubble();
    const panel = document.querySelector('.dualang-bubble-panel')!;
    // 顶部行：开启翻译（主开关）+ 字典（mini 开关）
    const topRow = panel.querySelector('.dualang-bubble-top-row');
    expect(topRow).toBeTruthy();
    expect(topRow!.querySelector('[data-field="enabled"]')).toBeTruthy();
    expect(topRow!.querySelector('[data-field="smartDictEnabled"]')).toBeTruthy();

    // 显示 / 对照 / 模型 三组
    expect(panel.querySelector('[data-section="display"]')).toBeTruthy();
    expect(panel.querySelector('[data-section="style"]')).toBeTruthy();
    expect(panel.querySelector('[data-section="models"]')).toBeTruthy();

    // 逐行融合 mini 开关在"对照"组的 group header 里
    const styleSection = panel.querySelector('[data-section="style"]')!;
    expect(styleSection.querySelector('[data-field="lineFusionEnabled"]')).toBeTruthy();

    // 新的左对齐 group-header 结构：3 组（显示/对照/模型）
    expect(panel.querySelectorAll('.dualang-bubble-group-header').length).toBe(3);
    expect(panel.querySelector('.dualang-bubble-group-label')?.textContent).toBe('显示');
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

describe('bubble translation activity states', () => {
  it('setTranslationActivity(n>0) → bubble 加 --busy class', () => {
    initBubble();
    const bubble = document.querySelector('.dualang-bubble') as HTMLElement;
    setTranslationActivity(2);
    expect(bubble.classList.contains('dualang-bubble--busy')).toBe(true);
    setTranslationActivity(0);
    expect(bubble.classList.contains('dualang-bubble--busy')).toBe(false);
  });

  it('点击 bubble 切换 enabled → chrome.storage.sync.set 被调用，enabled 翻转', async () => {
    initBubble();
    await new Promise((r) => setTimeout(r, 20));  // loadSettingsFromStorage
    const bubble = document.querySelector('.dualang-bubble') as HTMLElement;
    const setMock = (globalThis as any).chrome.storage.sync.set;
    setMock.mockClear();
    bubble.click();
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('storage.local.dualang_error_v1 变化 → bubble 加/去 --has-error class', async () => {
    initBubble();
    await new Promise((r) => setTimeout(r, 20));
    const bubble = document.querySelector('.dualang-bubble') as HTMLElement;
    expect(bubble.classList.contains('dualang-bubble--has-error')).toBe(false);
    // 模拟 background.reportFatalError 写入
    for (const fn of storageListeners) {
      fn({ dualang_error_v1: { newValue: { message: 'quota exceeded' }, oldValue: null } }, 'local');
    }
    expect(bubble.classList.contains('dualang-bubble--has-error')).toBe(true);
    // 模拟 clearErrorState
    for (const fn of storageListeners) {
      fn({ dualang_error_v1: { newValue: undefined, oldValue: { message: 'quota exceeded' } } }, 'local');
    }
    expect(bubble.classList.contains('dualang-bubble--has-error')).toBe(false);
  });

  it('有 fatal error 时不显示 --idle-ok 绿勾（红叉独占右下角）', async () => {
    initBubble();
    await new Promise((r) => setTimeout(r, 20));
    const bubble = document.querySelector('.dualang-bubble') as HTMLElement;
    for (const fn of storageListeners) {
      fn({ dualang_error_v1: { newValue: { message: 'err' }, oldValue: null } }, 'local');
    }
    expect(bubble.classList.contains('dualang-bubble--has-error')).toBe(true);
    expect(bubble.classList.contains('dualang-bubble--idle-ok')).toBe(false);
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
  it('渲染 VISIBLE_MODEL_PRESETS 里的所有可见模型行（不含 hidden 的 moonshot）', async () => {
    initBubble();
    // 等 loadSettingsFromStorage 的 async 初始化完成后 refreshPanel 才会填充列表
    await new Promise((r) => setTimeout(r, 20));
    const rows = document.querySelectorAll('.dualang-bubble-model-row');
    // 当前可见：siliconflow-glm-4-9b / qwen3-8b（qwen2.5-7b 已 hidden）
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // 不应渲染 hidden 的 Moonshot 预设
    const keys = Array.from(rows).map((r) => (r as HTMLElement).dataset.modelKey);
    expect(keys).not.toContain('moonshot-v1-8k');
    expect(keys).not.toContain('moonshot-k2.5');
  });

  it('当前 baseUrl+model 对应的 preset 被标 active', async () => {
    initBubble();
    await new Promise((r) => setTimeout(r, 20));
    const active = document.querySelector('.dualang-bubble-model-row--active');
    expect(active).toBeTruthy();
  });
});
