/**
 * 浮球（bubble）——全局快捷设置面板。
 *
 * 职责（重构后）：
 *   1. 始终可见（不再 article-scoped）
 *   2. 面板里暴露"开启/关闭翻译"、"显示模式"、"对照风格"、"模型切换" 4 组控件
 *   3. 检测到长文时额外显示"精翻此文"按钮，保留超级精翻入口
 *   4. 精翻进行中展示进度环 + 状态（idle / translating / done / failed）
 *
 * 设置通过 chrome.storage.sync.set 写回；content / background 各自的
 * onChanged 监听会自动 pickup。面板不持有应用层状态 —— 只镜像 storage。
 */
import { VISIBLE_MODEL_PRESETS, detectPreset, type ModelPreset } from '../shared/model-presets';

type State = 'idle' | 'translating' | 'done' | 'failed';
type DisplayMode = 'append' | 'translation-only' | 'inline' | 'bilingual';

export interface BubbleCallbacks {
  /** 用户点击"精翻此文"；提供长文 article 元素 */
  onSuperFineTrigger?: (article: Element) => void;
  /** 精翻进行中点击"取消" */
  onSuperFineCancel?: (article: Element) => void;
}

interface CurrentSettings {
  enabled: boolean;
  displayMode: DisplayMode;
  lineFusionEnabled: boolean;
  smartDictEnabled: boolean;
  baseUrl: string;
  model: string;
}

interface BubbleCtx {
  root: HTMLElement;
  ring: SVGCircleElement;
  panel: HTMLElement;
  state: State;
  progress: { completed: number; total: number } | null;
  settings: CurrentSettings;
  /** 当前检测到的长文 article（若有），用于精翻按钮 */
  currentLongArticle: Element | null;
  /** 正在精翻的 article（与 currentLongArticle 可能不同）*/
  superFineArticle: Element | null;
  callbacks: BubbleCallbacks;
  docHandlers: { move: (e: PointerEvent) => void; up: () => void };
  rttPollTimer: ReturnType<typeof setInterval> | null;
  rttByModel: Record<string, { avgMs: number; samples: number }>;
}

let ctx: BubbleCtx | null = null;

const STORAGE_KEY = 'dualang.bubble.top';
const RTT_POLL_INTERVAL_MS = 5_000;

export function initBubble(callbacks: BubbleCallbacks = {}): void {
  if (ctx) return;
  const root = document.createElement('div');
  root.className = 'dualang-bubble dualang-bubble--idle';
  root.innerHTML = `
    <svg class="dualang-bubble-ring-svg" viewBox="0 0 40 40">
      <circle class="dualang-bubble-ring-track" cx="20" cy="20" r="17" fill="none"/>
      <circle class="dualang-bubble-ring" cx="20" cy="20" r="17" fill="none" data-progress="0"/>
    </svg>
    <img class="dualang-bubble-logo" alt="dualang" src="${chrome.runtime.getURL('icons/icon48.png')}">
  `;

  // 读 localStorage 恢复 Y 轴位置
  const savedTop = parseFloat(localStorage.getItem(STORAGE_KEY) || 'NaN');
  if (!isNaN(savedTop)) {
    root.style.top = `${savedTop}px`;
  }

  // 拖拽状态
  let dragState: { startY: number; startTop: number } | null = null;
  const DRAG_THRESHOLD = 4;
  let moved = false;

  const panel = document.createElement('div');
  panel.className = 'dualang-bubble-panel';
  panel.innerHTML = renderPanelTemplate();
  if (!isNaN(savedTop)) panel.style.top = `${savedTop}px`;

  root.addEventListener('click', () => {
    if (moved) { moved = false; return; }
    // 点击浮球自身切换 panel 显隐（hover 也显示，点击可粘住）
    panel.classList.toggle('dualang-bubble-panel--pinned');
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

  const onPointerMove = (e: PointerEvent) => {
    if (!dragState) return;
    const dy = e.clientY - dragState.startY;
    if (Math.abs(dy) > DRAG_THRESHOLD) moved = true;
    if (!moved) return;
    const nextTop = dragState.startTop + dy;
    const clamped = Math.max(20, Math.min(window.innerHeight - 60, nextTop));
    root.style.top = `${clamped}px`;
    panel.style.top = `${clamped}px`;
  };

  const onPointerUp = () => {
    if (!dragState) return;
    if (moved) {
      localStorage.setItem(STORAGE_KEY, root.style.top.replace('px', ''));
    }
    dragState = null;
  };

  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);

  document.body.appendChild(panel);
  document.body.appendChild(root);

  ctx = {
    root,
    ring: root.querySelector('.dualang-bubble-ring')!,
    panel,
    state: 'idle',
    progress: null,
    settings: {
      enabled: true,
      displayMode: 'append',
      lineFusionEnabled: false,
      smartDictEnabled: false,
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'THUDM/GLM-4-9B-0414',
    },
    currentLongArticle: null,
    superFineArticle: null,
    callbacks,
    docHandlers: { move: onPointerMove, up: onPointerUp },
    rttPollTimer: null,
    rttByModel: {},
  };

  // hover 悬停展示面板；点击可粘住（加 --pinned class）
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  const showPanel = () => {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    refreshPanel();
    panel.classList.add('dualang-bubble-panel--visible');
  };
  const hidePanel = () => {
    hideTimer = setTimeout(() => {
      if (!panel.classList.contains('dualang-bubble-panel--pinned')) {
        panel.classList.remove('dualang-bubble-panel--visible');
      }
    }, 120);
  };
  root.addEventListener('pointerenter', showPanel);
  root.addEventListener('pointerleave', hidePanel);
  panel.addEventListener('pointerenter', showPanel);
  panel.addEventListener('pointerleave', hidePanel);

  wirePanelControls();
  loadSettingsFromStorage().then(() => refreshPanel());
  startRttPoll();

  // storage 变更（popup 里改设置）同步到 panel 选中态
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !ctx) return;
    let dirty = false;
    if (changes.enabled)   { ctx.settings.enabled = changes.enabled.newValue !== false; dirty = true; }
    if (changes.displayMode) { ctx.settings.displayMode = normalizeDisplayMode(changes.displayMode.newValue); dirty = true; }
    if (changes.lineFusionEnabled) { ctx.settings.lineFusionEnabled = !!changes.lineFusionEnabled.newValue; dirty = true; }
    if (changes.smartDictEnabled) { ctx.settings.smartDictEnabled = !!changes.smartDictEnabled.newValue; dirty = true; }
    if (changes.baseUrl)   { ctx.settings.baseUrl = changes.baseUrl.newValue || ''; dirty = true; }
    if (changes.model)     { ctx.settings.model = changes.model.newValue || ''; dirty = true; }
    if (dirty) refreshPanel();
  });
}

/**
 * 内容脚本发现长文时调用。浮球记下该 article，面板会显示"精翻此文"按钮。
 * 传 null 表示没有长文（用户滚出）。
 */
export function setLongArticle(article: Element | null): void {
  if (!ctx) return;
  if (ctx.currentLongArticle === article) return;
  ctx.currentLongArticle = article;
  refreshPanel();
}

/**
 * 精翻状态回调入口（translateArticleSuperFine 里调）。
 * articleId 参数保留是为了 e2e 兼容；实际 ctx 通过 superFineArticle 引用跟踪。
 */
export function setBubbleState(
  articleId: string,
  state: State,
  progress?: { completed: number; total: number },
): void {
  if (!ctx) return;
  ctx.state = state;
  ctx.progress = progress ?? null;
  for (const s of ['idle', 'translating', 'done', 'failed'] as State[]) {
    ctx.root.classList.toggle(`dualang-bubble--${s}`, s === state);
  }
  if (state === 'translating' && progress && progress.total > 0) {
    const p = progress.completed / progress.total;
    ctx.ring.setAttribute('data-progress', p.toFixed(2));
    ctx.root.style.setProperty('--progress', String(p));
  } else {
    ctx.root.style.setProperty('--progress', state === 'done' ? '1' : '0');
  }
  if (ctx.panel.classList.contains('dualang-bubble-panel--visible')) refreshPanel();
}

/** 记下当前精翻的目标 article（供 cancel 回调找得到），super-fine-bubble 流程专用 */
export function bindSuperFineArticle(article: Element | null): void {
  if (!ctx) return;
  ctx.superFineArticle = article;
}

export function disposeBubble(): void {
  if (!ctx) return;
  document.removeEventListener('pointermove', ctx.docHandlers.move);
  document.removeEventListener('pointerup', ctx.docHandlers.up);
  if (ctx.rttPollTimer) clearInterval(ctx.rttPollTimer);
  ctx.root.remove();
  ctx.panel.remove();
  ctx = null;
}

// ===================== 内部：面板模板与交互 =====================

function renderPanelTemplate(): string {
  return `
    <div class="dualang-bubble-panel-section dualang-bubble-top-row">
      <label class="dualang-bubble-switch">
        <input type="checkbox" data-field="enabled" />
        <span>开启翻译</span>
      </label>
      <label class="dualang-bubble-switch dualang-bubble-switch--mini" data-section="smart-dict" title="智能字典（英文原文生僻词）">
        <input type="checkbox" data-field="smartDictEnabled" />
        <span>字典</span>
      </label>
    </div>

    <div class="dualang-bubble-panel-section" data-section="display">
      <div class="dualang-bubble-group-header">
        <span class="dualang-bubble-group-label">显示</span>
        <span class="dualang-bubble-group-line"></span>
      </div>
      <div class="dualang-bubble-segment">
        <button type="button" data-display="original">只看原文</button>
        <button type="button" data-display="translation-only">只看译文</button>
        <button type="button" data-display="contrast">对照</button>
      </div>
    </div>

    <div class="dualang-bubble-panel-section" data-section="style">
      <div class="dualang-bubble-group-header">
        <span class="dualang-bubble-group-label">对照</span>
        <span class="dualang-bubble-group-line"></span>
        <label class="dualang-bubble-switch dualang-bubble-switch--mini" data-section="line-fusion" title="多行原文时逐行融合">
          <input type="checkbox" data-field="lineFusionEnabled" />
          <span>逐行</span>
        </label>
      </div>
      <div class="dualang-bubble-segment">
        <button type="button" data-style="append">强调原文</button>
        <button type="button" data-style="bilingual">强调译文</button>
      </div>
    </div>

    <div class="dualang-bubble-panel-section" data-section="models">
      <div class="dualang-bubble-group-header">
        <span class="dualang-bubble-group-label">模型</span>
        <span class="dualang-bubble-group-line"></span>
      </div>
      <div class="dualang-bubble-models" data-slot="models"></div>
    </div>

    <div class="dualang-bubble-panel-section" data-section="super-fine" hidden>
      <button type="button" class="dualang-bubble-super-fine-btn" data-action="super-fine">
        精翻此文
      </button>
      <button type="button" class="dualang-bubble-super-fine-cancel" data-action="super-fine-cancel" hidden>
        取消精翻
      </button>
    </div>
  `;
}

function wirePanelControls(): void {
  if (!ctx) return;
  const panel = ctx.panel;

  panel.querySelectorAll<HTMLInputElement>('input[data-field]').forEach((input) => {
    input.addEventListener('change', (e) => {
      const el = e.currentTarget as HTMLInputElement;
      const field = el.dataset.field;
      if (field === 'enabled') writeSettings({ enabled: el.checked });
      else if (field === 'lineFusionEnabled') writeSettings({ lineFusionEnabled: el.checked });
      else if (field === 'smartDictEnabled') writeSettings({ smartDictEnabled: el.checked });
    });
  });

  panel.querySelectorAll<HTMLButtonElement>('[data-display]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.display;
      if (kind === 'original') writeSettings({ enabled: false });
      else if (kind === 'translation-only') writeSettings({ enabled: true, displayMode: 'translation-only' });
      else if (kind === 'contrast') {
        // 对照：若当前就是 append/bilingual 保持；否则默认 append（强调原文）
        const cur = ctx?.settings.displayMode;
        const next: DisplayMode = (cur === 'append' || cur === 'bilingual') ? cur : 'append';
        writeSettings({ enabled: true, displayMode: next });
      }
    });
  });

  panel.querySelectorAll<HTMLButtonElement>('[data-style]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.style as 'append' | 'bilingual';
      writeSettings({ enabled: true, displayMode: kind });
    });
  });

  panel.querySelector<HTMLButtonElement>('[data-action="super-fine"]')?.addEventListener('click', () => {
    if (!ctx?.currentLongArticle) return;
    ctx.callbacks.onSuperFineTrigger?.(ctx.currentLongArticle);
  });
  panel.querySelector<HTMLButtonElement>('[data-action="super-fine-cancel"]')?.addEventListener('click', () => {
    if (!ctx?.superFineArticle) return;
    ctx.callbacks.onSuperFineCancel?.(ctx.superFineArticle);
  });
}

function refreshPanel(): void {
  if (!ctx) return;
  const s = ctx.settings;
  const panel = ctx.panel;

  const enabledEl = panel.querySelector<HTMLInputElement>('[data-field="enabled"]');
  if (enabledEl) enabledEl.checked = s.enabled;
  const lineFusionEl = panel.querySelector<HTMLInputElement>('[data-field="lineFusionEnabled"]');
  if (lineFusionEl) lineFusionEl.checked = !!s.lineFusionEnabled;
  const smartDictEl = panel.querySelector<HTMLInputElement>('[data-field="smartDictEnabled"]');
  if (smartDictEl) smartDictEl.checked = !!s.smartDictEnabled;

  // 显示模式 segment 选中态
  panel.querySelectorAll<HTMLButtonElement>('[data-display]').forEach((b) => {
    const kind = b.dataset.display;
    const active =
      (kind === 'original' && !s.enabled) ||
      (kind === 'translation-only' && s.enabled && s.displayMode === 'translation-only') ||
      (kind === 'contrast' && s.enabled && (s.displayMode === 'append' || s.displayMode === 'bilingual'));
    b.classList.toggle('dualang-bubble-segment-btn--active', !!active);
  });

  // 对照风格子选项仅在"对照"模式下可操作；其他模式 dim
  const isContrast = s.enabled && (s.displayMode === 'append' || s.displayMode === 'bilingual');
  const styleSection = panel.querySelector<HTMLElement>('[data-section="style"]');
  if (styleSection) styleSection.classList.toggle('dualang-bubble-panel-section--muted', !isContrast);
  const lineFusionSection = panel.querySelector<HTMLElement>('[data-section="line-fusion"]');
  if (lineFusionSection) lineFusionSection.classList.toggle('dualang-bubble-panel-section--muted', !isContrast);
  if (lineFusionEl) lineFusionEl.disabled = !isContrast;
  panel.querySelectorAll<HTMLButtonElement>('[data-style]').forEach((b) => {
    const kind = b.dataset.style;
    b.classList.toggle('dualang-bubble-segment-btn--active', isContrast && s.displayMode === kind);
  });

  // 模型列表
  renderModelList();

  // 精翻入口：仅在检测到长文且设置启用 时显示
  const sfSection = panel.querySelector<HTMLElement>('[data-section="super-fine"]');
  if (sfSection) {
    const visible = !!ctx.currentLongArticle && s.enabled;
    sfSection.hidden = !visible;
    const trig = sfSection.querySelector<HTMLButtonElement>('[data-action="super-fine"]');
    const canc = sfSection.querySelector<HTMLButtonElement>('[data-action="super-fine-cancel"]');
    const busy = ctx.state === 'translating';
    if (trig) trig.hidden = busy;
    if (canc) canc.hidden = !busy;
    if (busy && ctx.progress) {
      sfSection.setAttribute('data-progress', `${ctx.progress.completed}/${ctx.progress.total}`);
    } else {
      sfSection.removeAttribute('data-progress');
    }
  }
}

function renderModelList(): void {
  if (!ctx) return;
  const slot = ctx.panel.querySelector<HTMLElement>('[data-slot="models"]');
  if (!slot) return;
  const s = ctx.settings;
  const activePresetKey = detectPreset(s.baseUrl, s.model)?.key || '';

  slot.innerHTML = '';
  for (const preset of VISIBLE_MODEL_PRESETS) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'dualang-bubble-model-row';
    row.dataset.modelKey = preset.key;
    if (preset.key === activePresetKey) row.classList.add('dualang-bubble-model-row--active');

    const name = document.createElement('span');
    name.className = 'dualang-bubble-model-name';
    name.textContent = preset.displayName;

    const latency = document.createElement('span');
    latency.className = 'dualang-bubble-model-latency';
    latency.textContent = formatLatency(ctx.rttByModel[preset.model]?.avgMs);

    row.appendChild(name);
    row.appendChild(latency);
    row.addEventListener('click', () => onPickModel(preset));
    slot.appendChild(row);
  }
}

function formatLatency(avgMs: number | undefined): string {
  if (avgMs === undefined || !Number.isFinite(avgMs)) return '—';
  const s = avgMs / 1000;
  return `${s.toFixed(s < 10 ? 1 : 0)}s`;
}

async function onPickModel(preset: ModelPreset): Promise<void> {
  if (!ctx) return;
  const patch: Record<string, unknown> = {
    baseUrl: preset.baseUrl,
    model: preset.model,
    providerType: 'openai',
  };
  const key = await fetchProviderKey(preset.provider);
  if (key) patch.apiKey = key;
  await chrome.storage.sync.set(patch);
}

async function fetchProviderKey(provider: string): Promise<string> {
  // config.json 不是 web_accessible_resource —— content script 直接 fetch 会被
  // 浏览器拒载（"chrome-extension://invalid/"）。由 background 读并返回 key。
  try {
    const resp: any = await chrome.runtime.sendMessage({ action: 'getProviderKey', provider });
    if (!resp?.success) return '';
    return String(resp?.data?.apiKey || '');
  } catch (_) {
    return '';
  }
}

async function loadSettingsFromStorage(): Promise<void> {
  if (!ctx) return;
  const s = await chrome.storage.sync.get({
    enabled: true,
    displayMode: 'append',
    bilingualMode: false,
    lineFusionEnabled: false,
    smartDictEnabled: false,
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'THUDM/GLM-4-9B-0414',
  });
  ctx.settings = {
    enabled: s.enabled !== false,
    displayMode: normalizeDisplayMode(s.displayMode, s.bilingualMode),
    lineFusionEnabled: !!s.lineFusionEnabled,
    smartDictEnabled: !!s.smartDictEnabled,
    baseUrl: s.baseUrl || '',
    model: s.model || '',
  };
}

function normalizeDisplayMode(raw: unknown, legacyBilingual?: unknown): DisplayMode {
  const valid: DisplayMode[] = ['append', 'translation-only', 'inline', 'bilingual'];
  if (typeof raw === 'string' && (valid as string[]).includes(raw)) return raw as DisplayMode;
  return legacyBilingual ? 'inline' : 'append';
}

function startRttPoll(): void {
  if (!ctx) return;
  const poll = async () => {
    try {
      const resp: any = await chrome.runtime.sendMessage({ action: 'getRecentRtt' });
      if (resp?.success && ctx) {
        ctx.rttByModel = resp.data || {};
        if (ctx.panel.classList.contains('dualang-bubble-panel--visible')) renderModelList();
      }
    } catch (_) { /* background 可能未就绪 */ }
  };
  void poll();
  ctx.rttPollTimer = setInterval(poll, RTT_POLL_INTERVAL_MS);
}

async function writeSettings(patch: Partial<{ enabled: boolean; displayMode: DisplayMode; lineFusionEnabled: boolean; smartDictEnabled: boolean }>): Promise<void> {
  await chrome.storage.sync.set(patch);
}

// ===================== 保留旧 API 以保持 e2e/tests 兼容 =====================
// 旧的 trackArticle / untrackArticle 语义是"当前 article 进出视口"。
// 重构后浮球不再与 article 绑定，这两个函数降级为：
//   - trackArticle(el) → 如果 el 是长文，setLongArticle(el)
//   - untrackArticle(el) → 如果 el === currentLongArticle，setLongArticle(null)
// 使得旧测试能继续跑通，同时新代码路径统一走 setLongArticle。

export function trackArticle(article: Element): void {
  if (!article) return;
  setLongArticle(article);
}

export function untrackArticle(article: Element): void {
  if (ctx?.currentLongArticle === article) setLongArticle(null);
}
