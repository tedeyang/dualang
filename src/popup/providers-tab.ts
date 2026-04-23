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
} from '../background/router/storage';
import { makeProviderId } from '../background/router/migration';
import type { ProviderEntry } from '../shared/router-types';

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
        <button data-action="toggle" class="btn-secondary">${p.enabled ? '禁用' : '启用'}</button>
        <button data-action="test" class="btn-secondary" disabled title="P3 采样器开发中">测试</button>
        <button data-action="delete" class="btn-secondary btn-danger">删除</button>
      </div>
    </div>
  `;
}

/** 纯函数：校验新增 / 编辑表单输入 */
export function validateProviderForm(input: {
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}): string | null {
  if (!input.label.trim()) return '请填写名称';
  if (!input.baseUrl.trim()) return '请填写 API 地址';
  try {
    const u = new URL(input.baseUrl.trim());
    if (!/^https?:$/.test(u.protocol)) return 'API 地址必须是 http(s)';
  } catch {
    return 'API 地址格式不合法';
  }
  if (!input.model.trim()) return '请填写模型名';
  if (!input.apiKey.trim()) return '请填写 API Key';
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

  function resetForm() {
    labelEl.value = '';
    baseEl.value = '';
    modelEl.value = '';
    keyEl.value = '';
    tagsEl.value = '';
    errEl.style.display = 'none';
    errEl.textContent = '';
  }

  function showForm(show: boolean) {
    form.style.display = show ? '' : 'none';
    addBtn.style.display = show ? 'none' : '';
    if (show) labelEl.focus();
  }

  addBtn.addEventListener('click', () => {
    resetForm();
    showForm(true);
  });
  cancelBtn.addEventListener('click', () => showForm(false));

  saveBtn.addEventListener('click', async () => {
    const input = {
      label: labelEl.value,
      baseUrl: baseEl.value,
      model: modelEl.value,
      apiKey: keyEl.value,
      tags: tagsEl.value,
    };
    const err = validateProviderForm(input);
    if (err) {
      errEl.textContent = err;
      errEl.className = 'status error';
      errEl.style.display = '';
      return;
    }
    const entry = buildProviderEntry(input);
    await upsertProvider(entry);
    await setApiKey(entry.id, input.apiKey.trim());
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
      // P3 接入
      return;
    }
  });

  await refresh();
}
