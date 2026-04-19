type State = 'idle' | 'translating' | 'done' | 'failed';

interface Callbacks {
  onTrigger: (articleId: string) => void;
  onCancel: (articleId: string) => void;
}

interface BubbleCtx {
  root: HTMLElement;
  ring: SVGCircleElement;
  label: HTMLElement;
  panel: HTMLElement;
  tracked: WeakSet<Element>;
  currentArticleId: string | null;
  state: State;
  progress: { completed: number; total: number } | null;
  callbacks: Callbacks;
}

let ctx: BubbleCtx | null = null;

const STORAGE_KEY = 'dualang.bubble.top';

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

  // Read saved position from localStorage
  const savedTop = parseFloat(localStorage.getItem(STORAGE_KEY) || 'NaN');
  if (!isNaN(savedTop)) {
    root.style.top = `${savedTop}px`;
  }

  // Drag state variables (closed over by click + pointer handlers)
  let dragState: { startY: number; startTop: number } | null = null;
  const DRAG_THRESHOLD = 4;
  let moved = false;

  root.addEventListener('click', () => {
    if (moved) { moved = false; return; }
    if (!ctx?.currentArticleId) return;
    if (ctx.state === 'idle' || ctx.state === 'failed') {
      ctx.callbacks.onTrigger(ctx.currentArticleId);
    }
  });

  root.addEventListener('pointerdown', (e) => {
    const parsedTop = parseFloat(root.style.top);
    let baseline = parsedTop;
    if (isNaN(baseline)) {
      const computed = parseFloat(getComputedStyle(root).top);
      baseline = isNaN(computed) ? e.clientY : computed;
    }
    dragState = { startY: e.clientY, startTop: baseline };
    moved = false;
    try { root.setPointerCapture(e.pointerId); } catch (_) {}
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
  document.body.appendChild(root);

  ctx = {
    root,
    ring: root.querySelector('.dualang-bubble-ring')!,
    label: root.querySelector('.dualang-bubble-label')!,
    panel,
    tracked: new WeakSet(),
    currentArticleId: null,
    state: 'idle',
    progress: null,
    callbacks,
  };

  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  const showPanel = () => {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    renderPanel();
    panel.classList.add('dualang-bubble-panel--visible');
  };
  const hidePanel = () => {
    hideTimer = setTimeout(() => panel.classList.remove('dualang-bubble-panel--visible'), 100);
  };
  root.addEventListener('pointerenter', showPanel);
  root.addEventListener('pointerleave', hidePanel);
  panel.addEventListener('pointerenter', showPanel);
  panel.addEventListener('pointerleave', hidePanel);

  panel.querySelector('.dualang-bubble-panel-cancel')!.addEventListener('click', () => {
    if (ctx?.currentArticleId) ctx.callbacks.onCancel(ctx.currentArticleId);
  });
  panel.querySelector('.dualang-bubble-panel-retry')!.addEventListener('click', () => {
    if (ctx?.currentArticleId) ctx.callbacks.onTrigger(ctx.currentArticleId);
  });
}

export function trackArticle(article: Element): void {
  if (!ctx) return;
  const id = article.getAttribute('data-dualang-article-id');
  if (!id) return;
  if (ctx.tracked.has(article)) return;
  ctx.tracked.add(article);
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
  ctx.progress = progress ?? null;
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
  // 面板内容随状态变化重新渲染（panel 可见时）
  if (ctx.panel.classList.contains('dualang-bubble-panel--visible')) renderPanel();
}

function renderPanel() {
  if (!ctx) return;
  const summary = ctx.panel.querySelector('.dualang-bubble-panel-summary') as HTMLElement;
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

export function disposeBubble(): void {
  ctx?.root.remove();
  ctx?.panel.remove();
  ctx = null;
}
