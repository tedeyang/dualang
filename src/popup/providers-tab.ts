/**
 * Providers tab（MVP · P2）：
 *  - 列出已配置的 provider（由 migration 自动初始化 1-3 条）
 *  - 新增 / 编辑 / 删除 / 启用-禁用
 *  - 展示 capability + circuit 状态（pills）
 *  - "测试"按钮留占位，P3 接上 sampler
 *
 * 存储走 background/router/storage —— popup 上下文能直接访问 chrome.storage，
 * 不需要经由 background 转发，减少一次消息往返。
 */

import {
  listProviders,
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

/** 纯函数：构建一条卡片的 innerHTML */
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
  if (p.tags?.length) {
    for (const t of p.tags) pills.push(`<span class="pill">${escapeText(t)}</span>`);
  }
  const disabled = !p.enabled ? 'is-disabled' : '';

  return `
    <div class="provider-card ${disabled}" data-provider-id="${escapeText(p.id)}">
      <div class="provider-card__head">
        <div class="provider-card__label" title="${escapeText(p.id)}">${escapeText(p.label)}</div>
      </div>
      <div class="provider-card__sub">${escapeText(p.model)}</div>
      <div class="provider-card__sub">${escapeText(p.baseUrl)} · key: ${escapeText(maskedKey)}</div>
      <div class="provider-card__pills">${pills.join('')}</div>
      <div class="provider-card__actions">
        <button data-action="edit" class="btn-secondary">编辑</button>
        <button data-action="toggle" class="btn-secondary">${p.enabled ? '禁用' : '启用'}</button>
        <button data-action="test" class="btn-secondary" title="串行跑 short/medium/long single + batch-5 + stream；约 10K tokens">测试</button>
        <button data-action="delete" class="btn-secondary btn-danger">删除</button>
      </div>
      <div class="provider-card__sample" data-role="sample-log" style="display:none;"></div>
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

/** 纯函数：校验新增 / 编辑表单输入；编辑模式可传 {requireApiKey:false} 允许 key 留空保留原值 */
export function validateProviderForm(
  input: {
    label: string;
    baseUrl: string;
    model: string;
    apiKey: string;
  },
  opts: { requireApiKey?: boolean } = {},
): string | null {
  if (!input.label.trim()) return '请填写名称';
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
  input: { label: string; baseUrl: string; model: string; tags: string },
  now = Date.now(),
): ProviderEntry {
  const baseUrl = input.baseUrl.trim();
  const model = input.model.trim();
  const id = makeProviderId(baseUrl, model);
  const tags = input.tags
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  return {
    id,
    label: input.label.trim(),
    baseUrl,
    model,
    apiKeyRef: id,
    enabled: true,
    accountGroup: new URL(baseUrl).hostname.split('.').slice(-2, -1)[0],
    tags: tags.length ? tags : undefined,
    createdAt: now,
  };
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
  const tagsEl = byId<HTMLInputElement>('pfTags');
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
      ? '主从等价于现有行为：primary → secondary 顺序回退。'
      : '智能按 speed/quality/load/stability 综合评分动态选最优 provider。';
  }
  function updatePrefVisibility(mode: RoutingMode) {
    prefRow.style.opacity = mode === 'smart' ? '1' : '0.45';
    prefSlider.disabled = mode !== 'smart';
  }

  async function saveRouting() {
    const mode: RoutingMode = rmSmart.checked ? 'smart' : 'failover';
    const preference = parseInt(prefSlider.value, 10) / 100;
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

  async function refresh() {
    const providers = await listProviders();
    if (!providers.length) {
      listEl.innerHTML = '<div class="stats-empty">尚无 provider，点上方按钮新增一条。</div>';
      return;
    }
    // 并发拉取每个 provider 的 key/capability/circuit
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
  }

  let editingId: string | null = null;

  function resetForm() {
    labelEl.value = '';
    baseEl.value = '';
    modelEl.value = '';
    keyEl.value = '';
    tagsEl.value = '';
    errEl.style.display = 'none';
    errEl.textContent = '';
    // 退出编辑模式：解锁 baseUrl/model
    baseEl.readOnly = false;
    modelEl.readOnly = false;
    keyEl.placeholder = 'sk-...';
    saveBtn.textContent = '保存';
    editingId = null;
  }

  function showForm(show: boolean) {
    form.style.display = show ? '' : 'none';
    addBtn.style.display = show ? 'none' : '';
    if (show) labelEl.focus();
  }

  async function enterEditMode(id: string) {
    const p = (await listProviders()).find((x) => x.id === id);
    if (!p) return;
    resetForm();
    editingId = id;
    labelEl.value = p.label;
    baseEl.value = p.baseUrl;
    modelEl.value = p.model;
    tagsEl.value = (p.tags || []).join(' ');
    keyEl.value = '';
    // baseUrl + model 锁住：改了会变 provider id，等于删旧建新 —— 让用户显式删除重建
    baseEl.readOnly = true;
    modelEl.readOnly = true;
    keyEl.placeholder = '留空则保留原 key';
    saveBtn.textContent = '更新';
    showForm(true);
  }

  addBtn.addEventListener('click', () => {
    resetForm();
    showForm(true);
  });
  cancelBtn.addEventListener('click', () => {
    resetForm();
    showForm(false);
  });

  saveBtn.addEventListener('click', async () => {
    const input = {
      label: labelEl.value,
      baseUrl: baseEl.value,
      model: modelEl.value,
      apiKey: keyEl.value,
      tags: tagsEl.value,
    };
    const err = validateProviderForm(input, { requireApiKey: !editingId });
    if (err) {
      errEl.textContent = err;
      errEl.className = 'status error';
      errEl.style.display = '';
      return;
    }
    if (editingId) {
      // 编辑：只更新 label/tags/apiKey；保留 id/baseUrl/model/enabled/accountGroup/createdAt
      const all = await listProviders();
      const existing = all.find((p) => p.id === editingId);
      if (!existing) {
        errEl.textContent = '该 provider 已被删除，无法更新';
        errEl.className = 'status error';
        errEl.style.display = '';
        return;
      }
      const tagsArr = input.tags.split(/\s+/).map((t) => t.trim()).filter(Boolean);
      await upsertProvider({
        ...existing,
        label: input.label.trim(),
        tags: tagsArr.length ? tagsArr : undefined,
      });
      if (input.apiKey.trim()) {
        await setApiKey(editingId, input.apiKey.trim());
      }
    } else {
      const entry = buildProviderEntry(input);
      await upsertProvider(entry);
      await setApiKey(entry.id, input.apiKey.trim());
    }
    resetForm();
    showForm(false);
    await refresh();
  });

  listEl.addEventListener('click', async (ev) => {
    const target = ev.target as HTMLElement;
    const action = target.getAttribute?.('data-action');
    if (!action) return;
    const card = target.closest<HTMLElement>('.provider-card');
    const id = card?.getAttribute('data-provider-id');
    if (!id) return;

    if (action === 'delete') {
      if (!confirm('确定删除？该 provider 的 API key / 画像 / 熔断记录都会清掉。')) return;
      await deleteProviderRec(id);
      await refresh();
      return;
    }
    if (action === 'edit') {
      await enterEditMode(id);
      return;
    }
    if (action === 'toggle') {
      const all = await listProviders();
      const p = all.find((x) => x.id === id);
      if (!p) return;
      p.enabled = !p.enabled;
      await upsertProvider(p);
      await refresh();
      return;
    }
    if (action === 'test') {
      runTest(card!, id);
      return;
    }
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
        // 刷新卡片以应用新 capability pills
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
