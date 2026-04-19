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
