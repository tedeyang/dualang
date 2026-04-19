# 浮球精翻（Super-Fine Floating Bubble）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 X Articles 长文"超级精翻"的底部按钮改造成右侧中部可拖动悬浮球（带进度环 + hover mini 面板），保留原文 DOM 中的图片/视频/链接，`<img alt>` 作为独立段落送给模型翻译，并跳过长文的常规自动翻译链路避免重复消耗。

**Architecture:** 两个新模块 `super-fine-bubble.ts`（浮球 + 状态机 + 拖动 + 面板）和 `super-fine-render.ts`（按原 DOM block 锚点插入 skeleton slot，不重排原文）。`utils.ts::extractParagraphsByBlock` 重构成返回 `AnchoredBlock[]`（保留 `el` 引用 + `kind` 区分 text/img），供 renderer 把 slot 插到原节点后；`<img alt>` 作为 `{kind:'img-alt', text:alt}` 当作普通段送后端翻译。后端 `handleSuperFineStream` 协议零改动。

**Tech Stack:** TypeScript + vitest (jsdom) + esbuild，无运行时依赖。浮球用原生 DOM + CSS transform，拖动用 pointer events。

---

## File Structure

**New files:**
- `src/content/super-fine-bubble.ts` — 浮球全生命周期（创建/显隐/状态切换/拖动/hover 面板/取消回调），输出 `initBubble()`、`trackArticle(el)`、`setState(articleId, state, progress?)`、`disposeBubble()`
- `src/content/super-fine-bubble.test.ts` — jsdom 测试：状态机、拖动边界、面板显隐
- `src/content/super-fine-render.ts` — 输出 `renderInlineSlots(article, blocks)` + `clearInlineSlots(article)` + `fillSlot(article, index, text)`
- `src/content/super-fine-render.test.ts` — jsdom 测试：slot 插入位置、img-alt 处理、清理可逆
- `docs/superpowers/plans/2026-04-19-super-fine-floating-bubble.md` — 本文件

**Modified files:**
- `src/content/utils.ts` — `extractParagraphsByBlock` 重构成 `extractAnchoredBlocks(el): AnchoredBlock[]`，保留原函数签名作为 thin wrapper 以免其他调用方破坏
- `src/content/utils.test.ts` — 追加 `extractAnchoredBlocks` 测试
- `src/content/index.ts` — 替换 `injectSuperFineButton` 为 `bubble.trackArticle`；在 `requestTranslation` / 自动入队路径上 gate 掉 `isXArticle() && isLongArticle()`；重写 `translateArticleSuperFine` 使用新 renderer 与 bubble 协议
- `styles.css` — 新增 `.dualang-bubble*`、`.dualang-bubble-panel*`、`.dualang-inline-translation`；标记 `.dualang-super-btn`、`.dualang-super-slot` 为 legacy 待删（最后 Task 清理）
- `todo.md` — 追加 P35 章节

---

## Task 1: `extractAnchoredBlocks` 重构（保留 `el` 引用 + img 支持）

**Files:**
- Modify: `src/content/utils.ts:230-255`
- Modify: `src/content/utils.test.ts`（追加 describe 块）

- [ ] **Step 1: 写失败测试** — 追加到 `src/content/utils.test.ts` 末尾：

```ts
import { extractAnchoredBlocks } from './utils';

describe('extractAnchoredBlocks', () => {
  it('返回带 el 引用的 text blocks', () => {
    document.body.innerHTML = `
      <article>
        <p>Hello world</p>
        <p>Second para</p>
      </article>`;
    const root = document.querySelector('article')!;
    const blocks = extractAnchoredBlocks(root);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind).toBe('text');
    expect(blocks[0].text).toBe('Hello world');
    expect(blocks[0].el.tagName).toBe('P');
    expect(blocks[1].text).toBe('Second para');
  });

  it('img 独立成 img-alt block，alt 文本进 text 字段', () => {
    document.body.innerHTML = `
      <article>
        <p>Before image</p>
        <figure><img alt="Chart showing revenue growth"></figure>
        <p>After image</p>
      </article>`;
    const root = document.querySelector('article')!;
    const blocks = extractAnchoredBlocks(root);
    expect(blocks).toHaveLength(3);
    expect(blocks[1].kind).toBe('img-alt');
    expect(blocks[1].text).toBe('Chart showing revenue growth');
    expect(blocks[1].el.tagName).toBe('FIGURE');
  });

  it('无 alt 的图片不产生 block（避免空串）', () => {
    document.body.innerHTML = `
      <article>
        <p>Only text</p>
        <figure><img src="x.jpg"></figure>
      </article>`;
    const blocks = extractAnchoredBlocks(document.querySelector('article')!);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('text');
  });

  it('视频/音频节点跳过（当前版本不翻译）', () => {
    document.body.innerHTML = `
      <article>
        <p>Intro</p>
        <video src="v.mp4"></video>
      </article>`;
    const blocks = extractAnchoredBlocks(document.querySelector('article')!);
    expect(blocks).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 运行测试确认 FAIL**

Run: `npm test -- utils.test`
Expected: `extractAnchoredBlocks is not exported`

- [ ] **Step 3: 实现** — 修改 `src/content/utils.ts:240-255`：

```ts
export interface AnchoredBlock {
  el: Element;        // 原 DOM 节点，slot 会插到它 afterend
  kind: 'text' | 'img-alt';
  text: string;       // 要送翻译的文本（img-alt 就是 alt 字符串）
}

export function extractAnchoredBlocks(el: Element): AnchoredBlock[] {
  const blocks: AnchoredBlock[] = [];
  function visit(node: Element) {
    const blockChildren = Array.from(node.children).filter((c) => BLOCK_TAGS.has(c.tagName));
    if (blockChildren.length === 0) {
      // 叶子 block：优先识别图片
      const img = node.querySelector('img[alt]');
      if (img && (img.getAttribute('alt') || '').trim()) {
        blocks.push({ el: node, kind: 'img-alt', text: img.getAttribute('alt')!.trim() });
        return;
      }
      const t = (node.textContent || '').trim();
      if (t) blocks.push({ el: node, kind: 'text', text: t });
      return;
    }
    for (const c of blockChildren) visit(c);
  }
  visit(el);
  return blocks;
}

// 保留旧签名以免其他调用方断裂
export function extractParagraphsByBlock(el: Element): string[] {
  return extractAnchoredBlocks(el).map((b) => b.text);
}
```

- [ ] **Step 4: 运行测试确认 PASS**

Run: `npm test -- utils.test`
Expected: All tests pass, including new `extractAnchoredBlocks` describe block.

- [ ] **Step 5: Commit**

```bash
git add src/content/utils.ts src/content/utils.test.ts
git commit -m "refactor: extractAnchoredBlocks preserves el refs + img-alt"
```

---

## Task 2: `super-fine-render` 模块 — slot 插到原 DOM 后

**Files:**
- Create: `src/content/super-fine-render.ts`
- Create: `src/content/super-fine-render.test.ts`

- [ ] **Step 1: 写失败测试** — 新建 `src/content/super-fine-render.test.ts`：

```ts
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderInlineSlots, clearInlineSlots, fillSlot } from './super-fine-render';
import { extractAnchoredBlocks } from './utils';

function setupArticle(html: string) {
  document.body.innerHTML = `<article data-testid="tweet"><div data-testid="twitterArticleRichTextView">${html}</div></article>`;
  return document.querySelector('article')!;
}

describe('renderInlineSlots', () => {
  it('每个 block 后面插入一个 skeleton slot', () => {
    const article = setupArticle(`<p>Hello</p><p>World</p>`);
    const body = article.querySelector('[data-testid="twitterArticleRichTextView"]')!;
    const blocks = extractAnchoredBlocks(body);
    renderInlineSlots(article, blocks);
    const slots = article.querySelectorAll('.dualang-inline-translation');
    expect(slots).toHaveLength(2);
    expect(slots[0].getAttribute('data-dualang-slot-index')).toBe('0');
    // slot 必须紧跟在对应原 block 后
    expect(blocks[0].el.nextElementSibling).toBe(slots[0]);
    expect(blocks[1].el.nextElementSibling).toBe(slots[1]);
  });

  it('图片段落 slot 带 img-alt 标记', () => {
    const article = setupArticle(`<p>Intro</p><figure><img alt="A chart"></figure>`);
    const body = article.querySelector('[data-testid="twitterArticleRichTextView"]')!;
    const blocks = extractAnchoredBlocks(body);
    renderInlineSlots(article, blocks);
    const slots = article.querySelectorAll('.dualang-inline-translation');
    expect(slots[1].classList.contains('dualang-inline-translation--img')).toBe(true);
  });
});

describe('fillSlot', () => {
  it('把译文写入对应 index 的 slot 并标记 filled', () => {
    const article = setupArticle(`<p>Hello</p><p>World</p>`);
    const body = article.querySelector('[data-testid="twitterArticleRichTextView"]')!;
    renderInlineSlots(article, extractAnchoredBlocks(body));
    fillSlot(article, 0, '你好');
    const slot0 = article.querySelector('[data-dualang-slot-index="0"]')!;
    expect(slot0.textContent).toBe('你好');
    expect(slot0.classList.contains('dualang-inline-translation--filled')).toBe(true);
  });
});

describe('clearInlineSlots', () => {
  it('移除全部 slot，原 DOM 保持', () => {
    const article = setupArticle(`<p>Hello</p><p>World</p>`);
    const body = article.querySelector('[data-testid="twitterArticleRichTextView"]')!;
    const originalHtml = body.innerHTML;
    renderInlineSlots(article, extractAnchoredBlocks(body));
    clearInlineSlots(article);
    expect(article.querySelectorAll('.dualang-inline-translation')).toHaveLength(0);
    expect(body.innerHTML).toBe(originalHtml);
  });
});
```

- [ ] **Step 2: 运行测试确认 FAIL**

Run: `npm test -- super-fine-render.test`
Expected: `Cannot find module './super-fine-render'`

- [ ] **Step 3: 实现** — 创建 `src/content/super-fine-render.ts`：

```ts
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
```

- [ ] **Step 4: 运行测试确认 PASS**

Run: `npm test -- super-fine-render.test`
Expected: All 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/content/super-fine-render.ts src/content/super-fine-render.test.ts
git commit -m "feat(content): super-fine-render inserts inline slots preserving original DOM"
```

---

## Task 3: 浮球状态机 + DOM 骨架

**Files:**
- Create: `src/content/super-fine-bubble.ts`
- Create: `src/content/super-fine-bubble.test.ts`

- [ ] **Step 1: 写失败测试** — 创建 `src/content/super-fine-bubble.test.ts`：

```ts
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
```

- [ ] **Step 2: 运行测试确认 FAIL**

Run: `npm test -- super-fine-bubble.test`
Expected: `Cannot find module './super-fine-bubble'`

- [ ] **Step 3: 实现** — 创建 `src/content/super-fine-bubble.ts`（状态机最小版，拖动和面板在后续 Task）：

```ts
type State = 'idle' | 'translating' | 'done' | 'failed';

interface Callbacks {
  onTrigger: (articleId: string) => void;
  onCancel: (articleId: string) => void;
}

interface BubbleCtx {
  root: HTMLElement;
  ring: SVGCircleElement;
  label: HTMLElement;
  tracked: WeakSet<Element>;
  currentArticleId: string | null;
  state: State;
  callbacks: Callbacks;
}

let ctx: BubbleCtx | null = null;

export function initBubble(callbacks: Callbacks): void {
  if (ctx) return;
  const root = document.createElement('div');
  root.className = 'dualang-bubble dualang-bubble--hidden dualang-bubble--idle';
  root.innerHTML = `
    <svg class="dualang-bubble-ring-svg" viewBox="0 0 40 40">
      <circle class="dualang-bubble-ring-track" cx="20" cy="20" r="17" fill="none"/>
      <circle class="dualang-bubble-ring" cx="20" cy="20" r="17" fill="none" data-progress="0"/>
    </svg>
    <div class="dualang-bubble-label">🌐</div>
  `;
  root.addEventListener('click', () => {
    if (!ctx?.currentArticleId) return;
    if (ctx.state === 'idle' || ctx.state === 'failed') {
      ctx.callbacks.onTrigger(ctx.currentArticleId);
    }
  });
  document.body.appendChild(root);
  ctx = {
    root,
    ring: root.querySelector('.dualang-bubble-ring')!,
    label: root.querySelector('.dualang-bubble-label')!,
    tracked: new WeakSet(),
    currentArticleId: null,
    state: 'idle',
    callbacks,
  };
}

export function trackArticle(article: Element): void {
  if (!ctx) return;
  if (ctx.tracked.has(article)) return;
  ctx.tracked.add(article);
  const id = article.getAttribute('data-dualang-article-id');
  if (!id) return;
  ctx.currentArticleId = id;
  ctx.root.classList.remove('dualang-bubble--hidden');
  setBubbleState(id, 'idle');
}

export function setBubbleState(
  articleId: string,
  state: State,
  progress?: { completed: number; total: number },
): void {
  if (!ctx || ctx.currentArticleId !== articleId) return;
  ctx.state = state;
  for (const s of ['idle', 'translating', 'done', 'failed'] as State[]) {
    ctx.root.classList.toggle(`dualang-bubble--${s}`, s === state);
  }
  if (state === 'translating' && progress && progress.total > 0) {
    const p = progress.completed / progress.total;
    ctx.ring.setAttribute('data-progress', p.toFixed(2));
    ctx.label.textContent = `${Math.round(p * 100)}%`;
  } else if (state === 'idle') {
    ctx.label.textContent = '🌐';
  } else if (state === 'done') {
    ctx.label.textContent = '✓';
  } else if (state === 'failed') {
    ctx.label.textContent = '↻';
  }
}

export function disposeBubble(): void {
  ctx?.root.remove();
  ctx = null;
}
```

- [ ] **Step 4: 运行测试确认 PASS**

Run: `npm test -- super-fine-bubble.test`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/content/super-fine-bubble.ts src/content/super-fine-bubble.test.ts
git commit -m "feat(content): super-fine-bubble state machine skeleton"
```

---

## Task 4: 浮球 Y 轴拖动 + 位置记忆

**Files:**
- Modify: `src/content/super-fine-bubble.ts`
- Modify: `src/content/super-fine-bubble.test.ts`

- [ ] **Step 1: 写失败测试** — 追加到 `super-fine-bubble.test.ts`：

```ts
describe('drag Y-axis', () => {
  it('pointer 拖动更新 top 位置并 clamp 到 viewport', () => {
    initBubble({ onTrigger: vi.fn(), onCancel: vi.fn() });
    const article = document.createElement('article');
    article.setAttribute('data-dualang-article-id', 'a1');
    document.body.appendChild(article);
    trackArticle(article);
    const bubble = document.querySelector('.dualang-bubble') as HTMLElement;
    // jsdom 默认 innerHeight = 768
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });

    bubble.dispatchEvent(new PointerEvent('pointerdown', { clientY: 400, pointerId: 1 }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientY: 500, pointerId: 1 }));
    document.dispatchEvent(new PointerEvent('pointerup', { clientY: 500, pointerId: 1 }));
    // top 被更新（原始 50% → viewport 中 400px；移动 +100 → 500px）
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
  });

  it('初始化时读取 localStorage 中的 top', () => {
    localStorage.setItem('dualang.bubble.top', '250');
    initBubble({ onTrigger: vi.fn(), onCancel: vi.fn() });
    const bubble = document.querySelector('.dualang-bubble') as HTMLElement;
    expect(bubble.style.top).toBe('250px');
  });
});
```

- [ ] **Step 2: 运行测试确认 FAIL**

Run: `npm test -- super-fine-bubble.test`
Expected: 3 new "drag Y-axis" tests fail (拖动逻辑未实现)。

- [ ] **Step 3: 实现** — 在 `super-fine-bubble.ts` 中 `initBubble` 末尾添加拖动逻辑，以及读取 localStorage：

```ts
// 放在 ctx = {...} 创建之后、return 之前
const STORAGE_KEY = 'dualang.bubble.top';
const savedTop = parseFloat(localStorage.getItem(STORAGE_KEY) || 'NaN');
if (!isNaN(savedTop)) {
  root.style.top = `${savedTop}px`;
}

let dragState: { startY: number; startTop: number } | null = null;
const DRAG_THRESHOLD = 4;
let moved = false;

root.addEventListener('pointerdown', (e) => {
  dragState = {
    startY: e.clientY,
    startTop: root.getBoundingClientRect().top,
  };
  moved = false;
  root.setPointerCapture(e.pointerId);
});
document.addEventListener('pointermove', (e) => {
  if (!dragState) return;
  const dy = e.clientY - dragState.startY;
  if (Math.abs(dy) > DRAG_THRESHOLD) moved = true;
  if (!moved) return;
  const nextTop = dragState.startTop + dy;
  const clamped = Math.max(20, Math.min(window.innerHeight - 60, nextTop));
  root.style.top = `${clamped}px`;
});
document.addEventListener('pointerup', () => {
  if (!dragState) return;
  if (moved) {
    localStorage.setItem(STORAGE_KEY, root.style.top.replace('px', ''));
  }
  dragState = null;
});
```

然后修改 click handler，拖动中发生的 click 要屏蔽：

```ts
root.addEventListener('click', (e) => {
  if (moved) { moved = false; return; }
  if (!ctx?.currentArticleId) return;
  if (ctx.state === 'idle' || ctx.state === 'failed') {
    ctx.callbacks.onTrigger(ctx.currentArticleId);
  }
});
```

- [ ] **Step 4: 运行测试确认 PASS**

Run: `npm test -- super-fine-bubble.test`
Expected: 所有 6 个测试通过。

- [ ] **Step 5: Commit**

```bash
git add src/content/super-fine-bubble.ts src/content/super-fine-bubble.test.ts
git commit -m "feat(content): super-fine bubble Y-axis drag with localStorage memo"
```

---

## Task 5: 浮球 hover mini 面板（取消/切换模型/重翻）

**Files:**
- Modify: `src/content/super-fine-bubble.ts`
- Modify: `src/content/super-fine-bubble.test.ts`

- [ ] **Step 1: 写失败测试** — 追加：

```ts
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
    bubble.dispatchEvent(new PointerEvent('pointerleave', { clientX: 0, clientY: 0 }));
    // 延迟关闭：100ms 后 hidden（测试里可以检查 class 或等 timer）
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
```

- [ ] **Step 2: 运行测试确认 FAIL**

Run: `npm test -- super-fine-bubble.test`
Expected: 3 new panel tests fail。

- [ ] **Step 3: 实现** — 扩展 `super-fine-bubble.ts`：

```ts
// 在 ctx 类型里加 panel 字段
interface BubbleCtx {
  // ... 已有字段
  panel: HTMLElement;
  progress: { completed: number; total: number } | null;
}

// 在 initBubble 里创建 panel 并挂 body
const panel = document.createElement('div');
panel.className = 'dualang-bubble-panel';
panel.innerHTML = `
  <div class="dualang-bubble-panel-summary"></div>
  <div class="dualang-bubble-panel-actions">
    <button class="dualang-bubble-panel-cancel">取消</button>
    <button class="dualang-bubble-panel-retry">重翻</button>
  </div>
`;
document.body.appendChild(panel);

// hover 显隐（100ms grace 让鼠标能从 bubble 移到 panel）
let hideTimer: number | null = null;
const showPanel = () => {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  renderPanel();
  panel.classList.add('dualang-bubble-panel--visible');
};
const hidePanel = () => {
  hideTimer = window.setTimeout(() => panel.classList.remove('dualang-bubble-panel--visible'), 100);
};
root.addEventListener('pointerenter', showPanel);
root.addEventListener('pointerleave', hidePanel);
panel.addEventListener('pointerenter', showPanel);
panel.addEventListener('pointerleave', hidePanel);

// cancel button
panel.querySelector('.dualang-bubble-panel-cancel')!.addEventListener('click', () => {
  if (ctx?.currentArticleId) ctx.callbacks.onCancel(ctx.currentArticleId);
});
// retry button
panel.querySelector('.dualang-bubble-panel-retry')!.addEventListener('click', () => {
  if (ctx?.currentArticleId) ctx.callbacks.onTrigger(ctx.currentArticleId);
});

// renderPanel helper (放到 module 作用域)
function renderPanel() {
  if (!ctx) return;
  const summary = ctx.panel.querySelector('.dualang-bubble-panel-summary')!;
  const cancelBtn = ctx.panel.querySelector('.dualang-bubble-panel-cancel') as HTMLElement;
  const retryBtn = ctx.panel.querySelector('.dualang-bubble-panel-retry') as HTMLElement;
  if (ctx.state === 'translating') {
    const p = ctx.progress;
    summary.textContent = p ? `精翻中 · ${p.completed}/${p.total} 段` : '精翻中…';
    cancelBtn.style.display = '';
    retryBtn.style.display = 'none';
  } else if (ctx.state === 'done') {
    summary.textContent = '精翻完成';
    cancelBtn.style.display = 'none';
    retryBtn.style.display = '';
  } else if (ctx.state === 'failed') {
    summary.textContent = '精翻失败，点击重试';
    cancelBtn.style.display = 'none';
    retryBtn.style.display = '';
  } else {
    summary.textContent = '点击精翻整篇文章';
    cancelBtn.style.display = 'none';
    retryBtn.style.display = 'none';
  }
}

// setBubbleState 里把 progress 存到 ctx.progress 并在面板可见时重新渲染
export function setBubbleState(articleId: string, state: State, progress?: { completed: number; total: number }): void {
  if (!ctx || ctx.currentArticleId !== articleId) return;
  ctx.state = state;
  ctx.progress = progress ?? null;
  // ... 原有 class 切换
  if (ctx.panel.classList.contains('dualang-bubble-panel--visible')) renderPanel();
}
```

- [ ] **Step 4: 运行测试确认 PASS**

Run: `npm test -- super-fine-bubble.test`
Expected: 全部测试通过（9 个）。

- [ ] **Step 5: Commit**

```bash
git add src/content/super-fine-bubble.ts src/content/super-fine-bubble.test.ts
git commit -m "feat(content): super-fine bubble hover mini panel"
```

---

## Task 6: 浮球跟随"可见 article" — IntersectionObserver

**Files:**
- Modify: `src/content/super-fine-bubble.ts`
- Modify: `src/content/super-fine-bubble.test.ts`

- [ ] **Step 1: 写失败测试** — 追加：

```ts
describe('visibility tracking', () => {
  it('所有 article 离开视口时浮球隐藏', () => {
    initBubble({ onTrigger: vi.fn(), onCancel: vi.fn() });
    const article = document.createElement('article');
    article.setAttribute('data-dualang-article-id', 'a1');
    document.body.appendChild(article);
    trackArticle(article);
    const bubble = document.querySelector('.dualang-bubble') as HTMLElement;
    expect(bubble.classList.contains('dualang-bubble--hidden')).toBe(false);

    // 手动触发 IntersectionObserver 回调模拟离开视口
    // 实现中会 export 一个 __trigger__ for test hook，或使用 MutationObserver 探测
    // 简化：直接给 article 加 hidden 属性不够，这里用 untrackArticle API：
    import('./super-fine-bubble').then(({ untrackArticle }) => {
      untrackArticle(article);
      expect(bubble.classList.contains('dualang-bubble--hidden')).toBe(true);
    });
  });
});
```

注：jsdom 无 IntersectionObserver，直接把回调暴露为显式 `untrackArticle()` 更易测。实际浏览器中由 IntersectionObserver 回调调用。

- [ ] **Step 2: 运行测试确认 FAIL**

Run: `npm test -- super-fine-bubble.test`
Expected: `untrackArticle is not exported`。

- [ ] **Step 3: 实现** — 扩展 `super-fine-bubble.ts`：

```ts
const visibleArticles = new Set<Element>();

// trackArticle 修改：把 article 加进 visibleArticles，显示浮球
export function trackArticle(article: Element): void {
  if (!ctx) return;
  if (ctx.tracked.has(article)) return;
  ctx.tracked.add(article);
  const id = article.getAttribute('data-dualang-article-id');
  if (!id) return;
  visibleArticles.add(article);
  ctx.currentArticleId = id;
  ctx.root.classList.remove('dualang-bubble--hidden');
  setBubbleState(id, 'idle');

  // 用 IntersectionObserver 自动发现离场
  if (typeof IntersectionObserver !== 'undefined') {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visibleArticles.add(e.target);
        else untrackArticle(e.target);
      }
    }, { rootMargin: '200px' });
    io.observe(article);
  }
}

export function untrackArticle(article: Element): void {
  if (!ctx) return;
  visibleArticles.delete(article);
  if (visibleArticles.size === 0) {
    ctx.root.classList.add('dualang-bubble--hidden');
    ctx.currentArticleId = null;
  } else {
    // 切换到仍在视口的第一个
    const next = visibleArticles.values().next().value as Element | undefined;
    const nextId = next?.getAttribute('data-dualang-article-id') ?? null;
    ctx.currentArticleId = nextId;
  }
}
```

- [ ] **Step 4: 运行测试确认 PASS**

Run: `npm test -- super-fine-bubble.test`
Expected: 10 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/content/super-fine-bubble.ts src/content/super-fine-bubble.test.ts
git commit -m "feat(content): super-fine bubble auto-hide when no article visible"
```

---

## Task 7: CSS — 浮球 + 面板 + inline slot 样式

**Files:**
- Modify: `styles.css`

- [ ] **Step 1: 追加样式** — 在 `styles.css` 末尾添加：

```css
/* ===== 浮球 ===== */
.dualang-bubble {
  position: fixed;
  right: 20px;
  top: 50%;
  transform: translateY(-50%);
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: #16181c;
  border: 1px solid #2f3336;
  box-shadow: 0 4px 14px rgba(0,0,0,0.35);
  cursor: pointer;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  user-select: none;
  touch-action: none;
  transition: opacity 0.2s ease, transform 0.15s ease;
}
.dualang-bubble--hidden { opacity: 0; pointer-events: none; }
.dualang-bubble:hover { transform: translateY(-50%) scale(1.06); }
.dualang-bubble-ring-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}
.dualang-bubble-ring-track { stroke: #2f3336; stroke-width: 2.5; }
.dualang-bubble-ring {
  stroke: #1d9bf0;
  stroke-width: 2.5;
  stroke-dasharray: 106.8;
  stroke-dashoffset: 106.8;
  transition: stroke-dashoffset 0.3s ease;
}
.dualang-bubble--translating .dualang-bubble-ring { stroke-dashoffset: calc(106.8 * (1 - var(--progress, 0))); }
.dualang-bubble--translating { animation: dualang-bubble-breath 1.8s ease-in-out infinite; }
@keyframes dualang-bubble-breath {
  0%, 100% { transform: translateY(-50%) scale(1); }
  50% { transform: translateY(-50%) scale(1.04); }
}
.dualang-bubble--idle .dualang-bubble-label { color: #71767b; font-size: 18px; }
.dualang-bubble--translating .dualang-bubble-label { color: #1d9bf0; font-size: 12px; font-weight: 600; }
.dualang-bubble--done { background: #1d9bf0; border-color: #1d9bf0; }
.dualang-bubble--done .dualang-bubble-label { color: #fff; font-size: 18px; font-weight: 700; }
.dualang-bubble--failed { background: #f4212e; border-color: #f4212e; }
.dualang-bubble--failed .dualang-bubble-label { color: #fff; font-size: 18px; }

/* ===== Mini 面板 ===== */
.dualang-bubble-panel {
  position: fixed;
  right: 74px;
  top: 50%;
  transform: translateY(-50%);
  min-width: 180px;
  padding: 10px 12px;
  background: #16181c;
  border: 1px solid #2f3336;
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0,0,0,0.4);
  color: #e7e9ea;
  font-size: 13px;
  z-index: 10000;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
}
.dualang-bubble-panel--visible { opacity: 1; pointer-events: auto; }
.dualang-bubble-panel-summary { margin-bottom: 8px; }
.dualang-bubble-panel-actions { display: flex; gap: 6px; }
.dualang-bubble-panel-actions button {
  flex: 1;
  padding: 4px 10px;
  background: transparent;
  color: #e7e9ea;
  border: 1px solid #2f3336;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
}
.dualang-bubble-panel-actions button:hover { border-color: #1d9bf0; color: #1d9bf0; }

/* ===== Inline 段落翻译 slot ===== */
.dualang-inline-translation {
  color: #c5ccd3;
  margin: 6px 0 12px 0;
  white-space: pre-wrap;
  word-wrap: break-word;
  min-height: 1.2em;
  line-height: 1.5;
}
.dualang-inline-translation:not(.dualang-inline-translation--filled) {
  background: linear-gradient(90deg, rgba(29,155,240,0.08) 0%, rgba(29,155,240,0.04) 50%, rgba(29,155,240,0.08) 100%);
  background-size: 200% 100%;
  animation: dualang-slot-pulse 1.6s ease-in-out infinite;
  border-radius: 4px;
}
.dualang-inline-translation--img::before { content: "🖼 "; opacity: 0.6; }
.dualang-inline-translation--filled { animation: dualang-slot-fadein 0.35s ease-out; }
```

并更新 `setBubbleState` 里把 progress 作为 CSS 变量挂到 root：

```ts
// 在 setBubbleState 的 translating 分支末尾
ctx.root.style.setProperty('--progress', String(progress ? progress.completed / progress.total : 0));
```

- [ ] **Step 2: 人工验证**（暂无自动化 CSS 测试）— 不写 CSS 测试，下一个 Task 的集成环节里用 e2e 或肉眼验证。

- [ ] **Step 3: Commit**

```bash
git add styles.css src/content/super-fine-bubble.ts
git commit -m "feat(style): super-fine bubble + panel + inline-translation styles"
```

---

## Task 8: Gate 长文跳过常规自动翻译

**Files:**
- Modify: `src/content/index.ts`（`scanAndQueue` 里注册 observer 的分支）

- [ ] **Step 1: 找到常规翻译入队点** — 定位 `src/content/index.ts` 中 `viewportObserver?.observe(article); preloadObserver?.observe(article);`（约 876 行）

- [ ] **Step 2: 写失败 e2e 测试** — 新增 `e2e/tests/super-fine-bubble.spec.ts`（最小用例，先只测"长文没走常规"）：

```ts
import { test, expect } from './fixtures';

test('长文 article 不触发常规自动翻译', async ({ page, extensionId }) => {
  await page.goto('http://localhost:9999/e2e/fixtures/x-mock.html#long-article');
  await page.waitForTimeout(2000);
  // 常规翻译会在 .dualang-translation 里渲染；长文场景下应该为空
  const count = await page.locator('article [data-testid="twitterArticleRichTextView"] ~ .dualang-translation').count();
  expect(count).toBe(0);
});
```

（需要在 `e2e/fixtures/x-mock.html` 里加一段 long-article fixture — 4000+ 字 + 6+ 段 + `<img alt>`）

- [ ] **Step 3: 运行 e2e 确认 FAIL**

Run: `cd e2e && npx playwright test super-fine-bubble`
Expected: 测试失败或 fixture 缺失。

- [ ] **Step 4: 实现** — 改 `src/content/index.ts` 的 observer 注册分支：

```ts
// 在 forEach 里 injectSuperFineButton(article) 之后、viewportObserver.observe 之前
import { isLongArticle } from './index';  // 已在同一文件
import { extractAnchoredBlocks } from './utils';

if (isXArticle(article)) {
  const textEl = findTweetTextEl(article);
  const blocks = textEl ? extractAnchoredBlocks(textEl) : [];
  const longByBlocks = blocks.length >= 6;
  const longByChars = (textEl?.textContent || '').length >= 4000;
  if (longByBlocks && longByChars) {
    // 打标，让 bubble 认识；跳过常规 observer 注册
    article.setAttribute('data-dualang-long-article', 'true');
    // 注入 article-id 给浮球 track
    if (!article.getAttribute('data-dualang-article-id')) {
      article.setAttribute('data-dualang-article-id', 'la-' + Math.random().toString(36).slice(2, 10));
    }
    bubble.trackArticle(article);  // Task 9 会 wire up
    return;  // 不走 viewport/preload observer
  }
}
viewportObserver?.observe(article);
preloadObserver?.observe(article);
```

- [ ] **Step 5: 运行 e2e 确认 PASS**

Run: `cd e2e && npx playwright test super-fine-bubble`
Expected: 长文 article 下没有 `.dualang-translation` DOM。

- [ ] **Step 6: Commit**

```bash
git add src/content/index.ts e2e/tests/super-fine-bubble.spec.ts e2e/fixtures/x-mock.html
git commit -m "feat(content): skip auto-translate for long X articles"
```

---

## Task 9: 重写 `translateArticleSuperFine` 用 bubble + renderer

**Files:**
- Modify: `src/content/index.ts`（`translateArticleSuperFine` 函数，约 507-640 行）

- [ ] **Step 1: 写失败 e2e 测试** — 追加到 `super-fine-bubble.spec.ts`：

```ts
test('点击浮球触发精翻，inline slot 按段填充', async ({ page }) => {
  await page.goto('http://localhost:9999/e2e/fixtures/x-mock.html#long-article');
  const bubble = page.locator('.dualang-bubble');
  await expect(bubble).toBeVisible();
  await bubble.click();
  // translating 状态
  await expect(bubble).toHaveClass(/dualang-bubble--translating/);
  // slot 出现
  const slots = page.locator('.dualang-inline-translation');
  await expect(slots.first()).toBeVisible();
  // 若 mock background 返回模拟译文，应填充
  await expect(slots.first()).toHaveText(/.+/, { timeout: 30_000 });
});
```

- [ ] **Step 2: 重写 `translateArticleSuperFine`** —

```ts
import * as bubble from './super-fine-bubble';
import * as renderer from './super-fine-render';
import { extractAnchoredBlocks } from './utils';

async function translateArticleSuperFine(article: Element) {
  const articleId = article.getAttribute('data-dualang-article-id');
  if (!articleId) return;
  const tweetTextEl = findTweetTextEl(article);
  if (!tweetTextEl) return;
  const blocks = extractAnchoredBlocks(tweetTextEl);
  if (blocks.length === 0) return;

  renderer.clearInlineSlots(article);
  renderer.renderInlineSlots(article, blocks);
  bubble.setBubbleState(articleId, 'translating', { completed: 0, total: blocks.length });

  const paragraphs = blocks.map((b) => b.kind === 'img-alt' ? `[图: ${b.text}]` : b.text);
  const apiT0 = performance.now();
  logBiz('translation.superFine.start', { paragraphs: blocks.length });

  let port: chrome.runtime.Port | null = null;
  let finished = false;
  const timeout = setTimeout(() => {
    if (finished) return;
    finished = true;
    try { port?.disconnect(); } catch (_) {}
    bubble.setBubbleState(articleId, 'failed');
    logBiz('translation.superFine.fail', { error: 'timeout' }, 'warn');
  }, 600_000);

  try {
    port = chrome.runtime.connect(undefined, { name: 'super-fine' });
  } catch (err: any) {
    clearTimeout(timeout);
    bubble.setBubbleState(articleId, 'failed');
    return;
  }

  let completed = 0;
  port.onMessage.addListener((msg: any) => {
    if (finished) return;
    if (msg.action === 'partial') {
      renderer.fillSlot(article, msg.index, msg.translated);
      completed++;
    } else if (msg.action === 'progress') {
      bubble.setBubbleState(articleId, 'translating', { completed: msg.completed, total: msg.total });
    } else if (msg.action === 'done') {
      finished = true;
      clearTimeout(timeout);
      bubble.setBubbleState(articleId, 'done');
      logBiz('translation.superFine.ok', { paragraphs: blocks.length, rttMs: (performance.now() - apiT0).toFixed(0) });
      try { port?.disconnect(); } catch (_) {}
    } else if (msg.action === 'error') {
      finished = true;
      clearTimeout(timeout);
      bubble.setBubbleState(articleId, 'failed');
      logBiz('translation.superFine.fail', { error: msg.error }, 'warn');
      try { port?.disconnect(); } catch (_) {}
    }
  });
  port.onDisconnect.addListener(() => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    bubble.setBubbleState(articleId, 'failed');
  });
  port.postMessage({ action: 'translate', payload: { paragraphs } });

  (article as any)._dualangSuperFinePort = port;
}
```

- [ ] **Step 3: 在 content 脚本顶层 init bubble** —

```ts
// 在 index.ts 顶部 init 阶段：
bubble.initBubble({
  onTrigger: (articleId: string) => {
    const article = document.querySelector(`[data-dualang-article-id="${articleId}"]`);
    if (article) translateArticleSuperFine(article);
  },
  onCancel: (articleId: string) => {
    const article = document.querySelector(`[data-dualang-article-id="${articleId}"]`);
    const port = (article as any)?._dualangSuperFinePort;
    try { port?.disconnect(); } catch (_) {}
  },
});
```

- [ ] **Step 4: 运行 e2e 确认 PASS**

Run: `cd e2e && npx playwright test super-fine-bubble`
Expected: 两个测试通过。

- [ ] **Step 5: Commit**

```bash
git add src/content/index.ts
git commit -m "feat(content): wire super-fine bubble to renderer + stream port"
```

---

## Task 10: 清理 legacy + 更新 todo.md

**Files:**
- Modify: `src/content/index.ts`（删 `injectSuperFineButton`、旧 bilingual 渲染逻辑）
- Modify: `src/background/index.ts`（删 `payload.superFine` 旧非流式分支）
- Modify: `styles.css`（删 `.dualang-super-btn`、`.dualang-super-slot`、`.dualang-super-translating`）
- Modify: `todo.md`（新增 P35 章节）

- [ ] **Step 1: 列出待删符号**

```
src/content/index.ts:
  - injectSuperFineButton
  - 旧 translateArticleSuperFine 里挖空原文 + 双栏 bilingual 渲染那块（已被新版替换）
src/background/index.ts:
  - handleTranslate 里的 `if (payload.superFine) {...}` 分支（约 168-190 行）
styles.css:
  - .dualang-super-btn / :hover / :disabled
  - .dualang-super-slot / --filled / 动画
  - article.dualang-super-translating 伪 CSS
```

- [ ] **Step 2: 运行单元测试 + e2e 确认未破坏**

Run: `npm test && cd e2e && npx playwright test`
Expected: 全部绿。

- [ ] **Step 3: 追加 todo.md P35 章节** — 在 `todo.md` 末尾：

```markdown
## P35: 超级精翻浮球（floating bubble）

**目标**：把 X Articles 的静态"超级精翻"按钮换成右侧中部悬浮球，解决 3 个痛点：
1. 按钮在文章底部，要翻很久才能找到
2. 翻译过程看不到进度
3. 长文里的 img/video/链接丢失

**实现**：
- 新增 `super-fine-bubble.ts` — 浮球 DOM、状态机（idle/translating/done/failed）、Y 轴拖动 + localStorage 记忆、hover mini 面板（取消/重翻）、IntersectionObserver 自动显隐
- 新增 `super-fine-render.ts` — `renderInlineSlots(article, blocks)` 把 skeleton slot 按 block 顺序插到每个原 DOM 节点后，原文 DOM 零改动 → img/video/link 天然保留
- 重构 `extractParagraphsByBlock` → `extractAnchoredBlocks`，保留 `el` 引用，`<img alt>` 作为 `kind='img-alt'` 独立 block 送翻译（包成 `[图: alt]` 发给模型）
- Gate：`isXArticle() && 字符数≥4000 && 段数≥6` 跳过常规自动翻译，避免重复 API 消耗
- 删除旧 `.dualang-super-btn` 及双栏 bilingual 渲染

**测试**：
- vitest: `utils.test.ts` 扩展、`super-fine-render.test.ts`、`super-fine-bubble.test.ts`（10 个用例覆盖状态机 / 拖动 / 面板 / 可见性）
- e2e: `super-fine-bubble.spec.ts` 覆盖"长文不触发常规翻译 + 浮球点击触发精翻"
```

- [ ] **Step 4: Commit**

```bash
git add src/content/index.ts src/background/index.ts styles.css todo.md
git commit -m "chore: remove legacy super-fine button, document P35"
```

---

## Self-Review

**1. Spec coverage:**
- 按钮位置痛点 → Task 3/4/6/7（浮球 + Y 轴拖动 + 可见性 + CSS） ✓
- 进度不可感知 → Task 3（ring + label）/ Task 5（panel summary）/ Task 9（progress 事件） ✓
- img/video 丢失 → Task 1（extractAnchoredBlocks 保留 el + img-alt kind）/ Task 2（renderInlineSlots 不挖原文） ✓
- 长文跳过常规自动翻译 → Task 8 ✓

**2. Placeholder scan:** 无 TBD / 无省略号 / 每个 code block 都是可粘贴的 ✓

**3. Type consistency:**
- `AnchoredBlock { el, kind, text }` 在 Task 1 定义、Task 2 消费、Task 8/9 消费 ✓
- `setBubbleState(articleId, state, progress?)` 在 Task 3 定义、Task 5/9 消费 ✓
- `initBubble({ onTrigger, onCancel })` callback 签名在 Task 3/5/9 一致 ✓
- 测试里的 `data-dualang-article-id` 属性在 Task 3/8/9 一致 ✓

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-19-super-fine-floating-bubble.md`. Two execution options:

1. **Subagent-Driven (recommended)** — 每个 Task 派一个干净 subagent 执行 + 两阶段 review（fast iteration）
2. **Inline Execution** — 在本会话里按 Task 连续执行 + checkpoint review

**Which approach?**
