/**
 * Providers tab（MVP · P2）：
 *  - 列出已配置的 provider（由 migration 自动初始化 1-3 条）
 *  - 新增 / 编辑 / 删除 / 启用-禁用
 *  - 展示 capability + circuit 状态（pills）
 *  - 拖动卡片调整顺序（保存到 storage 的 providers[] 里）
 *  - 编辑用卡片内嵌表单，baseUrl/model/apiKey 全部可改（id 保持稳定）
 *  - "测试"按钮串行跑 sampler（short/medium/long + batch-5 + stream）
 *
 * 存储走 background/router/storage —— popup 上下文能直接访问 chrome.storage，
 * 不需要经由 background 转发，减少一次消息往返。
 */

import {
  listProviders,
  saveProviders,
  upsertProvider,
  deleteProvider as deleteProviderRec,
  getApiKey,
  setApiKey,
  getCapability,
  getCircuit,
  getRoutingSettings,
  setRoutingSettings,
} from '../background/router/storage';
import { makeProviderId } from '../background/router/migration';
import type { ProviderEntry, RoutingMode } from '../shared/router-types';
import { applyI18n, tr } from './i18n-apply';
import { log } from '../shared/logger';

function escapeText(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  );
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`providers-tab: #${id} not found`);
  return el as T;
}

export interface RenderedCardData {
  provider: ProviderEntry;
  capability?: Awaited<ReturnType<typeof getCapability>>;
  circuit?: Awaited<ReturnType<typeof getCircuit>>;
  maskedKey: string;
}

/** 纯函数：对 api key 做脱敏（保留首尾各 4 字符） */
export function maskApiKey(key: string): string {
  if (!key) return '未设置';
  if (key.length <= 10) return key.slice(0, 2) + '••••';
  return key.slice(0, 4) + '••••' + key.slice(-4);
}

/** 纯函数：从 circuit 状态推出 pill 文本和样式类 */
export function circuitBadge(circuit: Awaited<ReturnType<typeof getCircuit>> | undefined):
  | { text: string; cls: string }
  | null {
  if (!circuit || circuit.state === 'HEALTHY') return null;
  switch (circuit.state) {
    case 'COOLING': {
      const secLeft = Math.max(0, Math.round((circuit.cooldownUntil - Date.now()) / 1000));
      return { text: `cooling ${secLeft}s`, cls: 'pill--warn' };
    }
    case 'PROBING':
      return { text: `probing ${Math.round(circuit.probeWeight * 100)}%`, cls: 'pill--warn' };
    case 'PERMANENT_DISABLED':
      return { text: 'disabled', cls: 'pill--bad' };
  }
}

/** label 是可选字段 —— 没填时用 model 作为显示名。 */
function displayLabel(p: ProviderEntry): string {
  return (p.label && p.label.trim()) || p.model;
}

/** 纯函数：构建一条卡片的 innerHTML。包含 view + edit 两个子区域（edit 默认隐藏） */
export function renderCardHtml(data: RenderedCardData): string {
  const { provider: p, capability, maskedKey } = data;
  const pills: string[] = [];
  if (capability) {
    const batchCls =
      capability.batch === 'proven' ? 'pill--ok' : capability.batch === 'broken' ? 'pill--bad' : '';
    pills.push(`<span class="pill ${batchCls}">batch: ${capability.batch}</span>`);
    if (capability.streaming === 'broken') {
      pills.push(`<span class="pill pill--bad">stream: broken</span>`);
    } else if (capability.streaming === 'proven') {
      pills.push(`<span class="pill pill--ok">stream: ok</span>`);
    }
  } else {
    pills.push(`<span class="pill">未测</span>`);
  }
  const circuit = data.circuit;
  const badge = circuitBadge(circuit);
  if (badge) pills.push(`<span class="pill ${badge.cls}">${badge.text}</span>`);
  const disabled = !p.enabled ? 'is-disabled' : '';

  const toggleKey = p.enabled ? 'providers.btnDisable' : 'providers.btnEnable';
  const toggleFallback = p.enabled ? '禁用' : '启用';
  return `
    <div class="provider-card ${disabled}" data-provider-id="${escapeText(p.id)}" draggable="true">
      <div class="provider-card__view">
        <div class="provider-card__head">
          <span class="drag-handle" data-i18n-title="providers.dragHandleTitle" title="拖动调整顺序">⋮⋮</span>
          <div class="provider-card__label" title="${escapeText(p.id)}">${escapeText(displayLabel(p))}</div>
        </div>
        <div class="provider-card__sub">${escapeText(p.model)}</div>
        <div class="provider-card__sub">${escapeText(p.baseUrl)} · key: ${escapeText(maskedKey)}</div>
        <div class="provider-card__pills">${pills.join('')}</div>
        <div class="provider-card__actions">
          <button data-action="edit" class="btn-secondary" data-i18n="providers.btnEdit">编辑</button>
          <button data-action="toggle" class="btn-secondary" data-i18n="${toggleKey}">${toggleFallback}</button>
          <button data-action="test" class="btn-secondary" data-i18n="providers.btnTest">测试</button>
          <button data-action="delete" class="btn-secondary btn-danger" data-i18n="providers.btnDelete">删除</button>
        </div>
        <div class="provider-card__sample" data-role="sample-log" style="display:none;"></div>
      </div>
      <div class="provider-card__edit" style="display:none;">
        <div class="form-group">
          <label>
            <span data-i18n="providers.fieldLabel">名称</span>
            <span class="muted" data-i18n="providers.fieldLabelOpt">(选填)</span>
          </label>
          <input type="text" data-edit-field="label" value="${escapeText(p.label || '')}">
        </div>
        <div class="form-group">
          <label data-i18n="providers.fieldBaseUrl">API 地址</label>
          <input type="text" data-edit-field="baseUrl" value="${escapeText(p.baseUrl)}">
        </div>
        <div class="form-group">
          <label data-i18n="providers.fieldModel">模型名</label>
          <input type="text" data-edit-field="model" value="${escapeText(p.model)}">
        </div>
        <div class="form-group">
          <label>
            <span data-i18n="providers.fieldApiKey">API Key</span>
            <span class="muted" data-i18n="providers.editKeyHint">(留空保留原 key)</span>
          </label>
          <input type="password" data-edit-field="apiKey" placeholder="sk-...">
        </div>
        <div class="provider-card__actions">
          <button data-action="edit-save" class="btn-primary" data-i18n="providers.save">保存</button>
          <button data-action="edit-cancel" class="btn-secondary" data-i18n="providers.cancel">取消</button>
        </div>
        <div class="status error" data-role="edit-error" style="display:none;"></div>
      </div>
    </div>
  `;
}

// ============ Sampler UI 辅助 ============

const CASE_LABEL: Record<string, string> = {
  'short-single': '短文',
  'medium-single': '中文',
  'long-single': '长文',
  'batch-5': '批量×5',
  'stream-medium': '流式',
};

function fmtCaseLine(msg: { type: string; result?: any; error?: string }): string {
  if (msg.type === 'case' && msg.result) {
    const r = msg.result;
    const label = CASE_LABEL[r.name] || r.name;
    const badge = r.ok ? '✓' : '✗';
    const rtt = r.rttMs > 0 ? ` ${r.rttMs}ms` : '';
    const errTail = r.error ? ` · ${r.error}` : '';
    const cls = r.ok ? 'pill--ok' : 'pill--bad';
    return `<div class="sample-line"><span class="pill ${cls}">${badge}</span> <span>${label}${rtt}${errTail}</span></div>`;
  }
  if (msg.type === 'error') {
    return `<div class="sample-line"><span class="pill pill--bad">✗</span> <span>${msg.error || '未知错误'}</span></div>`;
  }
  return '';
}

/**
 * 纯函数：校验新增 / 编辑表单输入。
 *  - label 选填：不校验
 *  - baseUrl/model 必填；apiKey 在编辑模式可留空保留原值（opts.requireApiKey=false）
 */
export function validateProviderForm(
  input: {
    label: string;
    baseUrl: string;
    model: string;
    apiKey: string;
  },
  opts: { requireApiKey?: boolean } = {},
): string | null {
  if (!input.baseUrl.trim()) return '请填写 API 地址';
  try {
    const u = new URL(input.baseUrl.trim());
    if (!/^https?:$/.test(u.protocol)) return 'API 地址必须是 http(s)';
  } catch {
    return 'API 地址格式不合法';
  }
  if (!input.model.trim()) return '请填写模型名';
  if (opts.requireApiKey !== false && !input.apiKey.trim()) return '请填写 API Key';
  return null;
}

/** 纯函数：输入 → ProviderEntry（id 根据 baseUrl+model 派生） */
export function buildProviderEntry(
  input: { label: string; baseUrl: string; model: string },
  now = Date.now(),
): ProviderEntry {
  const baseUrl = input.baseUrl.trim();
  const model = input.model.trim();
  const id = makeProviderId(baseUrl, model);
  const label = input.label.trim();
  return {
    id,
    label,
    baseUrl,
    model,
    apiKeyRef: id,
    enabled: true,
    accountGroup: accountGroupFromBaseUrl(baseUrl),
    createdAt: now,
  };
}

function accountGroupFromBaseUrl(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).hostname.split('.').slice(-2, -1)[0];
  } catch {
    return undefined;
  }
}

// ============ DOM 生命周期 ============

export async function initProvidersTab(): Promise<void> {
  const listEl = byId<HTMLDivElement>('providerList');
  const addBtn = byId<HTMLButtonElement>('providerAddBtn');
  const form = byId<HTMLDivElement>('providerAddForm');
  const saveBtn = byId<HTMLButtonElement>('pfSaveBtn');
  const cancelBtn = byId<HTMLButtonElement>('pfCancelBtn');
  const errEl = byId<HTMLDivElement>('pfError');
  const labelEl = byId<HTMLInputElement>('pfLabel');
  const baseEl = byId<HTMLInputElement>('pfBaseUrl');
  const modelEl = byId<HTMLInputElement>('pfModel');
  const keyEl = byId<HTMLInputElement>('pfApiKey');
  const rmFailover = byId<HTMLInputElement>('rmFailover');
  const rmSmart = byId<HTMLInputElement>('rmSmart');
  const prefSlider = byId<HTMLInputElement>('prefSlider');
  const prefValLabel = byId<HTMLSpanElement>('prefValLabel');
  const prefRow = byId<HTMLDivElement>('prefRow');
  const routingHint = byId<HTMLParagraphElement>('routingHint');

  // 加载路由配置并初始化 UI
  const routing = await getRoutingSettings();
  rmFailover.checked = routing.mode === 'failover';
  rmSmart.checked = routing.mode === 'smart';
  prefSlider.value = String(Math.round(routing.preference * 100));
  prefValLabel.textContent = `${prefSlider.value}%`;
  updateRoutingHint(routing.mode);
  updatePrefVisibility(routing.mode);

  function updateRoutingHint(mode: RoutingMode) {
    routingHint.textContent = mode === 'failover'
      ? tr('providers.routingHintFailover')
      : tr('providers.routingHintSmart');
  }
  function updatePrefVisibility(mode: RoutingMode) {
    prefRow.style.opacity = mode === 'smart' ? '1' : '0.45';
    prefSlider.disabled = mode !== 'smart';
  }

  async function saveRouting() {
    const mode: RoutingMode = rmSmart.checked ? 'smart' : 'failover';
    const preference = parseInt(prefSlider.value, 10) / 100;
    if (mode !== routing.mode) {
      log.info('routing.mode.change', { from: routing.mode, to: mode });
    }
    await setRoutingSettings({ ...routing, mode, preference });
    routing.mode = mode;
    routing.preference = preference;
    updateRoutingHint(mode);
    updatePrefVisibility(mode);
  }

  rmFailover.addEventListener('change', saveRouting);
  rmSmart.addEventListener('change', saveRouting);
  prefSlider.addEventListener('input', () => {
    prefValLabel.textContent = `${prefSlider.value}%`;
  });
  prefSlider.addEventListener('change', saveRouting);

  // 每个卡片有自己内嵌的编辑表单；editingId 只用来保证"同一时刻最多一张卡处于编辑态"
  let editingId: string | null = null;

  async function refresh() {
    if (editingId) return;  // 编辑中不 refresh，避免把用户输入冲掉
    const providers = await listProviders();
    if (!providers.length) {
      listEl.innerHTML = `<div class="stats-empty">${tr('providers.empty')}</div>`;
      return;
    }
    const cards = await Promise.all(
      providers.map(async (p) => {
        const [apiKey, capability, circuit] = await Promise.all([
          getApiKey(p.id),
          getCapability(p.id),
          getCircuit(p.id),
        ]);
        return renderCardHtml({ provider: p, capability, circuit, maskedKey: maskApiKey(apiKey) });
      }),
    );
    listEl.innerHTML = cards.join('');
    applyI18n(listEl);  // 把新渲染的 data-i18n 节点翻译掉
  }

  function resetAddForm() {
    labelEl.value = '';
    baseEl.value = '';
    modelEl.value = '';
    keyEl.value = '';
    errEl.style.display = 'none';
    errEl.textContent = '';
  }

  function showAddForm(show: boolean) {
    form.style.display = show ? '' : 'none';
    addBtn.style.display = show ? 'none' : '';
    if (show) labelEl.focus();
  }

  addBtn.addEventListener('click', () => {
    cancelInlineEdit();
    resetAddForm();
    showAddForm(true);
  });
  cancelBtn.addEventListener('click', () => {
    resetAddForm();
    showAddForm(false);
  });

  // ===== 新增 provider（顶部共享表单）=====
  saveBtn.addEventListener('click', async () => {
    const input = {
      label: labelEl.value,
      baseUrl: baseEl.value,
      model: modelEl.value,
      apiKey: keyEl.value,
    };
    const err = validateProviderForm(input);
    if (err) {
      errEl.textContent = err;
      errEl.className = 'status error';
      errEl.style.display = '';
      return;
    }
    const entry = buildProviderEntry(input);
    log.info('providers.add', { id: entry.id, model: entry.model, baseUrl: entry.baseUrl });
    await upsertProvider(entry);
    await setApiKey(entry.id, input.apiKey.trim());
    resetAddForm();
    showAddForm(false);
    await refresh();
  });

  // ===== 行内编辑：在卡片自身展开编辑表单 =====
  function enterInlineEdit(card: HTMLElement, id: string) {
    showAddForm(false);
    cancelInlineEdit();
    editingId = id;
    card.classList.add('is-editing');
    card.setAttribute('draggable', 'false');
    const view = card.querySelector<HTMLDivElement>('.provider-card__view');
    const edit = card.querySelector<HTMLDivElement>('.provider-card__edit');
    if (view) view.style.display = 'none';
    if (edit) {
      edit.style.display = '';
      const labelInput = edit.querySelector<HTMLInputElement>('[data-edit-field="label"]');
      labelInput?.focus();
      labelInput?.select();
    }
  }

  function cancelInlineEdit() {
    if (!editingId) return;
    const card = listEl.querySelector<HTMLElement>(`.provider-card[data-provider-id="${CSS.escape(editingId)}"]`);
    if (card) {
      card.classList.remove('is-editing');
      card.setAttribute('draggable', 'true');
      const view = card.querySelector<HTMLDivElement>('.provider-card__view');
      const edit = card.querySelector<HTMLDivElement>('.provider-card__edit');
      if (view) view.style.display = '';
      if (edit) edit.style.display = 'none';
      const errBox = card.querySelector<HTMLDivElement>('[data-role="edit-error"]');
      if (errBox) {
        errBox.style.display = 'none';
        errBox.textContent = '';
      }
      const keyInput = card.querySelector<HTMLInputElement>('[data-edit-field="apiKey"]');
      if (keyInput) keyInput.value = '';
    }
    editingId = null;
  }

  async function saveInlineEdit(card: HTMLElement, id: string) {
    const labelInput = card.querySelector<HTMLInputElement>('[data-edit-field="label"]');
    const baseInput = card.querySelector<HTMLInputElement>('[data-edit-field="baseUrl"]');
    const modelInput = card.querySelector<HTMLInputElement>('[data-edit-field="model"]');
    const keyInput = card.querySelector<HTMLInputElement>('[data-edit-field="apiKey"]');
    const errBox = card.querySelector<HTMLDivElement>('[data-role="edit-error"]');
    if (!labelInput || !baseInput || !modelInput || !keyInput || !errBox) return;

    const existing = (await listProviders()).find((p) => p.id === id);
    if (!existing) {
      errBox.textContent = '该模型已被删除，无法更新';
      errBox.style.display = '';
      return;
    }

    const input = {
      label: labelInput.value,
      baseUrl: baseInput.value,
      model: modelInput.value,
      apiKey: keyInput.value,
    };
    const err = validateProviderForm(input, { requireApiKey: false });
    if (err) {
      errBox.textContent = err;
      errBox.style.display = '';
      return;
    }

    // id 保持稳定（存 apiKey / capability / circuit 的 key 都用它），baseUrl/model 原地改
    const newBaseUrl = input.baseUrl.trim();
    const newModel = input.model.trim();
    const baseUrlChanged = newBaseUrl !== existing.baseUrl;
    await upsertProvider({
      ...existing,
      label: input.label.trim(),
      baseUrl: newBaseUrl,
      model: newModel,
      accountGroup: baseUrlChanged ? accountGroupFromBaseUrl(newBaseUrl) : existing.accountGroup,
    });
    if (input.apiKey.trim()) {
      await setApiKey(id, input.apiKey.trim());
    }
    editingId = null;
    await refresh();
  }

  // ===== 卡片事件委托：按钮动作 =====
  listEl.addEventListener('click', async (ev) => {
    const target = ev.target as HTMLElement;
    const action = target.getAttribute?.('data-action');
    if (!action) return;
    const card = target.closest<HTMLElement>('.provider-card');
    const id = card?.getAttribute('data-provider-id');
    if (!card || !id) return;

    if (action === 'delete') {
      if (!confirm(tr('providers.deleteConfirm'))) return;
      if (editingId === id) editingId = null;
      log.info('providers.delete', { id });
      await deleteProviderRec(id);
      await refresh();
      return;
    }
    if (action === 'edit') {
      log.debug('providers.edit.open', { id });
      enterInlineEdit(card, id);
      return;
    }
    if (action === 'edit-save') {
      log.info('providers.edit.save', { id });
      await saveInlineEdit(card, id);
      return;
    }
    if (action === 'edit-cancel') {
      log.debug('providers.edit.cancel', { id });
      cancelInlineEdit();
      return;
    }
    if (action === 'toggle') {
      const all = await listProviders();
      const p = all.find((x) => x.id === id);
      if (!p) return;
      p.enabled = !p.enabled;
      log.info('providers.toggle', { id, enabled: p.enabled });
      await upsertProvider(p);
      await refresh();
      return;
    }
    if (action === 'test') {
      log.info('providers.test.start', { id });
      runTest(card, id);
      return;
    }
  });

  // ===== 拖拽重排：改 providers[] 数组顺序后持久化 =====
  listEl.addEventListener('dragstart', (ev) => {
    const card = (ev.target as HTMLElement).closest<HTMLElement>('.provider-card');
    if (!card || card.classList.contains('is-editing')) {
      ev.preventDefault();
      return;
    }
    const id = card.dataset.providerId;
    if (!id || !ev.dataTransfer) return;
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', id);
    card.classList.add('is-dragging');
  });

  listEl.addEventListener('dragend', () => {
    listEl.querySelectorAll('.provider-card.is-dragging').forEach((c) => c.classList.remove('is-dragging'));
    listEl.querySelectorAll('.provider-card.drop-before,.provider-card.drop-after').forEach((c) => {
      c.classList.remove('drop-before', 'drop-after');
    });
  });

  listEl.addEventListener('dragover', (ev) => {
    const card = (ev.target as HTMLElement).closest<HTMLElement>('.provider-card');
    if (!card) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    const rect = card.getBoundingClientRect();
    const insertAfter = ev.clientY > rect.top + rect.height / 2;
    listEl.querySelectorAll('.provider-card.drop-before,.provider-card.drop-after').forEach((c) => {
      if (c !== card) c.classList.remove('drop-before', 'drop-after');
    });
    card.classList.toggle('drop-before', !insertAfter);
    card.classList.toggle('drop-after', insertAfter);
  });

  listEl.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    const srcId = ev.dataTransfer?.getData('text/plain');
    const targetCard = (ev.target as HTMLElement).closest<HTMLElement>('.provider-card');
    listEl.querySelectorAll('.provider-card.drop-before,.provider-card.drop-after').forEach((c) => {
      c.classList.remove('drop-before', 'drop-after');
    });
    if (!srcId || !targetCard) return;
    const targetId = targetCard.dataset.providerId;
    if (!targetId || targetId === srcId) return;
    const rect = targetCard.getBoundingClientRect();
    const insertAfter = ev.clientY > rect.top + rect.height / 2;

    const list = await listProviders();
    const moved = list.find((p) => p.id === srcId);
    if (!moved) return;
    const withoutSrc = list.filter((p) => p.id !== srcId);
    const tgtIdx = withoutSrc.findIndex((p) => p.id === targetId);
    if (tgtIdx < 0) return;
    const insertAt = insertAfter ? tgtIdx + 1 : tgtIdx;
    withoutSrc.splice(insertAt, 0, moved);
    log.info('providers.reorder', { srcId, targetId, insertAfter, insertAt });
    await saveProviders(withoutSrc);
    await refresh();
  });

  function runTest(card: HTMLElement, providerId: string) {
    const logEl = card.querySelector<HTMLDivElement>('[data-role="sample-log"]');
    const buttons = card.querySelectorAll<HTMLButtonElement>('button');
    if (!logEl) return;
    buttons.forEach((b) => (b.disabled = true));
    logEl.innerHTML = '<div class="sample-line"><span class="pill">⏳</span> <span>采样中…</span></div>';
    logEl.style.display = '';

    let port: chrome.runtime.Port | null = null;
    try {
      port = chrome.runtime.connect(undefined, { name: 'router-sample' });
    } catch (e: any) {
      logEl.innerHTML = `<div class="sample-line"><span class="pill pill--bad">✗</span> <span>连接 background 失败：${escapeText(e?.message || e)}</span></div>`;
      buttons.forEach((b) => (b.disabled = false));
      return;
    }

    let finished = false;
    const cleanup = () => {
      buttons.forEach((b) => (b.disabled = false));
    };

    port.onMessage.addListener((msg: any) => {
      if (msg.type === 'case') {
        logEl.insertAdjacentHTML('beforeend', fmtCaseLine(msg));
      } else if (msg.type === 'done') {
        finished = true;
        logEl.insertAdjacentHTML(
          'beforeend',
          `<div class="sample-line"><span class="pill pill--ok">✓</span> <span>完成（${Math.round(msg.totalRttMs / 1000)}s）</span></div>`,
        );
        cleanup();
        setTimeout(() => { refresh().catch(() => {}); }, 600);
      } else if (msg.type === 'error') {
        finished = true;
        logEl.insertAdjacentHTML('beforeend', fmtCaseLine(msg));
        cleanup();
      }
    });
    port.onDisconnect.addListener(() => {
      if (!finished) {
        logEl.insertAdjacentHTML(
          'beforeend',
          '<div class="sample-line"><span class="pill pill--bad">✗</span> <span>连接被中断</span></div>',
        );
        cleanup();
      }
    });
    port.postMessage({ action: 'start', providerId });
  }

  await refresh();
}
