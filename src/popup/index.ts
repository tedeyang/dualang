import { getModelMeta } from '../shared/model-meta';
import { MODEL_PRESETS, detectPreset as detectPresetShared } from '../shared/model-presets';

// popup DOM 是静态的；找不到就是 HTML/bundle 不对应，fail-fast 比到处 null 检查更清晰
function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`popup: #${id} not found`);
  return el as T;
}

document.addEventListener('DOMContentLoaded', async () => {
  const presetSelect = byId<HTMLSelectElement>('preset');
  const baseUrlInput = byId<HTMLInputElement>('baseUrl');
  const apiKeyInput = byId<HTMLInputElement>('apiKey');
  const modelInput = byId<HTMLInputElement>('model');
  const reasoningEffortSelect = byId<HTMLSelectElement>('reasoningEffort');
  const maxTokensInput = byId<HTMLInputElement>('maxTokens');
  const enableStreamingCheckbox = byId<HTMLInputElement>('enableStreaming');
  const targetLangSelect = byId<HTMLSelectElement>('targetLang');
  const autoTranslateCheckbox = byId<HTMLInputElement>('autoTranslate');
  const displayModeSelect = byId<HTMLSelectElement>('displayMode');
  const fallbackEnabledCheckbox = byId<HTMLInputElement>('fallbackEnabled');
  const fallbackPresetSelect = byId<HTMLSelectElement>('fallbackPreset');
  const fallbackBaseUrlInput = byId<HTMLInputElement>('fallbackBaseUrl');
  const fallbackApiKeyInput = byId<HTMLInputElement>('fallbackApiKey');
  const fallbackModelInput = byId<HTMLInputElement>('fallbackModel');
  const hedgedRequestCheckbox = byId<HTMLInputElement>('hedgedRequestEnabled');
  const hedgedDelayModeSelect = byId<HTMLSelectElement>('hedgedDelayMode');
  const hedgedDelayReadout = byId<HTMLDivElement>('hedgedDelayReadout');
  const fallbackConfigDiv = byId<HTMLDivElement>('fallbackConfig');
  const errorBanner = byId<HTMLDivElement>('errorBanner');
  const saveBtn = byId<HTMLButtonElement>('saveBtn');
  const statusDiv = byId<HTMLDivElement>('status');

  async function loadLocalConfig() {
    try {
      const res = await fetch(chrome.runtime.getURL('config.json'));
      if (!res.ok) return {};
      return await res.json();
    } catch (e) {
      return {};
    }
  }

  const localConfig = await loadLocalConfig();

  // 展示错误横幅（主 API 发生致命错误时）
  const errorState = await chrome.storage.local.get('dualang_error_v1');
  const errorInfo = errorState['dualang_error_v1'];
  if (errorInfo?.message) {
    errorBanner.textContent = `⚠️ ${errorInfo.message}`;
    errorBanner.style.display = 'block';
    errorBanner.addEventListener('click', async () => {
      await chrome.storage.local.remove('dualang_error_v1');
      chrome.action.setBadgeText({ text: '' }).catch(() => {});
      errorBanner.style.display = 'none';
    });
  }

  // 从 shared/model-presets.ts 读的 MODEL_PRESETS 现在是数组；popup 里按 key 查字典效率足够
  const PRESETS: Record<string, { baseUrl: string; model: string; provider: string; providerType: string }> = {};
  for (const p of MODEL_PRESETS) {
    PRESETS[p.key] = {
      baseUrl: p.baseUrl, model: p.model, provider: p.provider, providerType: p.providerType,
    };
  }

  // Fallback presets 只取 siliconflow 家族（其他作为主模型不作兜底）
  const FALLBACK_PRESETS: Record<string, { baseUrl: string; model: string }> = {};
  for (const p of MODEL_PRESETS) {
    if (p.provider === 'siliconflow') {
      FALLBACK_PRESETS[p.key] = { baseUrl: p.baseUrl, model: p.model };
    }
  }

  function detectPreset(baseUrl: string, model: string): string {
    const p = detectPresetShared(baseUrl, model);
    return p ? p.key : 'custom';
  }

  const defaultApiKey = localConfig?.providers?.moonshot?.apiKey || '';
  const defaultFallbackApiKey = localConfig?.providers?.siliconflow?.apiKey || '';

  const defaultSiliconFlowKey = localConfig?.providers?.siliconflow?.apiKey || '';
  // 默认主模型：SiliconFlow 免费 GLM-4-9B-0414
  // 理由（bench v2）：1.9s 延迟、质量 8.7、稳定性完美、完全免费；Qwen2.5 需 T=0.1 否则有退化风险
  const settings = await chrome.storage.sync.get({
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: defaultSiliconFlowKey || defaultApiKey,
    model: 'THUDM/GLM-4-9B-0414',
    providerType: 'openai',
    reasoningEffort: 'none',
    maxTokens: 4096,
    enableStreaming: false,
    targetLang: 'zh-CN',
    autoTranslate: true,
    // displayMode 替代旧 bilingualMode（布尔）。老用户若只有 bilingualMode，
    // 下面的加载逻辑会把 bilingualMode=true 迁移为 'inline'。
    // 用 null 作为"未设置"哨兵，避免 chrome.storage API 对 undefined 默认值的序列化歧义。
    displayMode: null,
    bilingualMode: false,
    fallbackEnabled: false,
    fallbackBaseUrl: 'https://api.siliconflow.cn/v1',
    fallbackApiKey: defaultFallbackApiKey,
    fallbackModel: 'THUDM/GLM-4-9B-0414',
    hedgedRequestEnabled: false,
    hedgedDelayMs: 'auto'  // 'auto' | 0 | number (ms)
  });

  baseUrlInput.value = settings.baseUrl;
  apiKeyInput.value = settings.apiKey;
  modelInput.value = settings.model;
  reasoningEffortSelect.value = settings.reasoningEffort;
  maxTokensInput.value = settings.maxTokens;
  enableStreamingCheckbox.checked = settings.enableStreaming;
  targetLangSelect.value = settings.targetLang;
  autoTranslateCheckbox.checked = settings.autoTranslate;
  // 迁移：displayMode 未设 + 老 bilingualMode=true → 'inline'；否则默认 'append'
  const VALID_DISPLAY_MODES = ['append', 'translation-only', 'inline', 'bilingual'];
  const resolvedDisplayMode = VALID_DISPLAY_MODES.includes(settings.displayMode)
    ? settings.displayMode
    : (settings.bilingualMode ? 'inline' : 'append');
  displayModeSelect.value = resolvedDisplayMode;
  presetSelect.value = detectPreset(settings.baseUrl, settings.model);

  // Fallback 配置
  fallbackEnabledCheckbox.checked = settings.fallbackEnabled;
  fallbackBaseUrlInput.value = settings.fallbackBaseUrl;
  fallbackApiKeyInput.value = settings.fallbackApiKey;
  fallbackModelInput.value = settings.fallbackModel;
  hedgedRequestCheckbox.checked = settings.hedgedRequestEnabled;
  // hedgedDelayMs: 'auto' / '0' / '300' / '600' / '1000' / '2000'
  {
    const v = settings.hedgedDelayMs;
    const optionValue = (v === 'auto' || v === undefined || v === null) ? 'auto' : String(v);
    const exists = Array.from(hedgedDelayModeSelect.options).some(o => o.value === optionValue);
    hedgedDelayModeSelect.value = exists ? optionValue : 'auto';
  }
  fallbackConfigDiv.style.display = settings.fallbackEnabled ? '' : 'none';

  function detectFallbackPreset(baseUrl, model) {
    for (const [key, cfg] of Object.entries(FALLBACK_PRESETS)) {
      if (baseUrl === cfg.baseUrl && model === cfg.model) return key;
    }
    return 'custom';
  }
  fallbackPresetSelect.value = detectFallbackPreset(settings.fallbackBaseUrl, settings.fallbackModel);

  // 浏览器本地翻译不需要 API Key / baseUrl；切换时锁定相关输入
  function applyBrowserNativeMode(on) {
    const disabled = on;
    apiKeyInput.disabled = disabled;
    baseUrlInput.disabled = disabled;
    modelInput.disabled = disabled;
    maxTokensInput.disabled = disabled;
    reasoningEffortSelect.disabled = disabled;
    enableStreamingCheckbox.disabled = disabled;
    fallbackEnabledCheckbox.disabled = disabled; // fallback 是 HTTP API 专用概念
    if (on) {
      apiKeyInput.placeholder = '浏览器本地翻译无需 API Key';
    } else {
      apiKeyInput.placeholder = 'sk-...';
    }
  }
  applyBrowserNativeMode(settings.providerType === 'browser-native');

  presetSelect.addEventListener('change', () => {
    const key = presetSelect.value;
    if (PRESETS[key]) {
      baseUrlInput.value = PRESETS[key].baseUrl;
      modelInput.value = PRESETS[key].model;
      const isBrowserNative = PRESETS[key].providerType === 'browser-native';
      applyBrowserNativeMode(isBrowserNative);
      if (isBrowserNative) {
        apiKeyInput.value = 'browser-native'; // 占位，通过非空校验
      } else {
        const providerKey = localConfig?.providers?.[PRESETS[key].provider]?.apiKey;
        if (providerKey) apiKeyInput.value = providerKey;
      }
    }
  });

  fallbackEnabledCheckbox.addEventListener('change', () => {
    fallbackConfigDiv.style.display = fallbackEnabledCheckbox.checked ? '' : 'none';
  });

  fallbackPresetSelect.addEventListener('change', () => {
    const key = fallbackPresetSelect.value;
    if (FALLBACK_PRESETS[key]) {
      fallbackBaseUrlInput.value = FALLBACK_PRESETS[key].baseUrl;
      fallbackModelInput.value = FALLBACK_PRESETS[key].model;
      const sfKey = localConfig?.providers?.siliconflow?.apiKey;
      if (sfKey) fallbackApiKeyInput.value = sfKey;
    }
  });

  saveBtn.addEventListener('click', async () => {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
      showStatus('请输入 API Key', 'error');
      return;
    }

    const baseUrl = (baseUrlInput.value || 'https://api.moonshot.cn/v1').trim();
    const maxTokens = parseInt(maxTokensInput.value, 10);
    if (isNaN(maxTokens) || maxTokens < 1) {
      showStatus('Max Output Tokens 必须是大于 0 的数字', 'error');
      return;
    }

    const presetKey = presetSelect.value;
    const providerType = (PRESETS[presetKey]?.providerType) || 'openai';

    await chrome.storage.sync.set({
      baseUrl,
      apiKey,
      model: (modelInput.value || 'moonshot-v1-8k').trim(),
      providerType,
      reasoningEffort: reasoningEffortSelect.value,
      maxTokens,
      enableStreaming: enableStreamingCheckbox.checked,
      targetLang: targetLangSelect.value,
      autoTranslate: autoTranslateCheckbox.checked,
      displayMode: displayModeSelect.value,
      // 旧 bilingualMode 字段设回 false，防止未来其他代码路径误读老值
      bilingualMode: false,
      fallbackEnabled: fallbackEnabledCheckbox.checked,
      fallbackBaseUrl: (fallbackBaseUrlInput.value || 'https://api.siliconflow.cn/v1').trim(),
      fallbackApiKey: fallbackApiKeyInput.value.trim(),
      fallbackModel: (fallbackModelInput.value || 'THUDM/GLM-4-9B-0414').trim(),
      hedgedRequestEnabled: hedgedRequestCheckbox.checked,
      hedgedDelayMs: hedgedDelayModeSelect.value === 'auto' ? 'auto' : parseInt(hedgedDelayModeSelect.value, 10)
    });

    // 保存时清除旧的错误状态（用户已知晓）
    await chrome.storage.local.remove('dualang_error_v1');
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
    errorBanner.style.display = 'none';

    showStatus('设置已保存', 'success');
  });

  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = 'status ' + type;
    setTimeout(() => {
      statusDiv.textContent = '';
      statusDiv.className = 'status';
    }, 2000);
  }

  // ===== Stats tab =====
  // 统计数据 render：调用 background 的 getStats，展示汇总卡片、各模型行、错误日志
  const statTotalReqs = document.getElementById('statTotalReqs');
  const statTotalTokens = document.getElementById('statTotalTokens');
  const statCacheHitRate = document.getElementById('statCacheHitRate');
  const modelStatsList = document.getElementById('modelStatsList');
  const errorLogList = document.getElementById('errorLogList');
  const refreshStatsBtn = document.getElementById('refreshStatsBtn');
  const resetStatsBtn = document.getElementById('resetStatsBtn');

  function fmtNum(n) {
    if (n === undefined || n === null || !Number.isFinite(n)) return '–';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
    return String(Math.round(n));
  }

  function fmtPct(num, den) {
    if (!den) return '–';
    return ((num / den) * 100).toFixed(1) + '%';
  }

  function fmtTs(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  // 与 src/shared/model-meta.ts 对齐的品牌检测 —— 供 popup 内嵌渲染。
  // 保持最小实现，只用 baseUrl / 模型名就能判出图标路径和友好名称。
  function modelBrand(modelKey) {
    const m = String(modelKey || '').toLowerCase();
    if (modelKey === 'browser-native') {
      const isEdge = /Edg\//.test(navigator.userAgent || '');
      return {
        iconUrl: chrome.runtime.getURL(isEdge ? 'icons/edge.svg' : 'icons/chrome.svg'),
        displayName: isEdge ? 'Edge 本地' : 'Chrome 本地',
      };
    }
    if (m.includes('kimi') || m.includes('moonshot')) {
      return { iconUrl: chrome.runtime.getURL('icons/kimi.png'), displayName: modelKey };
    }
    if (m.includes('qwen')) {
      return { iconUrl: chrome.runtime.getURL('icons/qwen.png'), displayName: modelKey };
    }
    if (m.includes('glm')) {
      return { iconUrl: chrome.runtime.getURL('icons/zai.svg'), displayName: modelKey };
    }
    return { iconUrl: chrome.runtime.getURL('icons/icon48.png'), displayName: modelKey || '未知模型' };
  }

  function successClass(rate) {
    if (rate >= 0.95) return 'good';
    if (rate >= 0.80) return 'warn';
    return 'bad';
  }

  type ModelStatsRow = {
    reqs: number; successes: number; failures: number;
    rttTotalMs: number; rttCount: number;
    tokensTotal: number;
  };
  function renderStats(stats: any) {
    const models: Record<string, ModelStatsRow> = stats?.models || {};
    const entries: Array<[string, ModelStatsRow]> = Object.entries(models)
      .sort((a, b) => (b[1].reqs || 0) - (a[1].reqs || 0));
    let totalReqs = 0, totalTokens = 0, totalSuccess = 0;
    for (const [, m] of entries) {
      totalReqs += m.reqs || 0;
      totalTokens += m.tokensTotal || 0;
      totalSuccess += m.successes || 0;
    }
    const cacheHits = stats?.cacheHits || 0;
    const cacheDen = totalReqs + cacheHits;

    statTotalReqs.textContent = fmtNum(totalReqs);
    statTotalTokens.textContent = fmtNum(totalTokens);
    statCacheHitRate.textContent = cacheDen === 0 ? '–' : fmtPct(cacheHits, cacheDen);

    if (entries.length === 0) {
      modelStatsList.innerHTML = '<div class="stats-empty">尚无数据，打开 X.com 浏览几条推文后再来看。</div>';
    } else {
      modelStatsList.innerHTML = '';
      for (const [key, m] of entries) {
        const brand = modelBrand(key);
        const rate = m.reqs > 0 ? m.successes / m.reqs : 0;
        const avgRtt = m.rttCount > 0 ? Math.round(m.rttTotalMs / m.rttCount) : null;
        const row = document.createElement('div');
        row.className = 'model-row';
        row.innerHTML = `
          <img class="model-row__icon" src="${brand.iconUrl}" alt="">
          <div class="model-row__body">
            <div class="model-row__name" title="${escapeText(key)}">${escapeText(brand.displayName)}</div>
            <div class="model-row__metrics">
              <span>avg <strong>${avgRtt === null ? '–' : avgRtt + 'ms'}</strong></span>
              <span>tokens <strong>${fmtNum(m.tokensTotal || 0)}</strong></span>
              <span>请求 <strong>${m.reqs}</strong></span>
            </div>
            <div class="success-bar">
              <div class="success-bar__fill success-bar__fill--${successClass(rate)}" style="width:${(rate * 100).toFixed(1)}%"></div>
            </div>
            <div class="success-label">${m.reqs === 0 ? '–' : `${(rate * 100).toFixed(1)}% 成功率（${m.successes}/${m.reqs}）`}</div>
          </div>
        `;
        modelStatsList.appendChild(row);
      }
    }

    const errors = stats?.errors || [];
    if (errors.length === 0) {
      errorLogList.innerHTML = '<li class="stats-empty-li">暂无错误</li>';
    } else {
      errorLogList.innerHTML = '';
      for (const e of errors.slice(0, 10)) {
        const li = document.createElement('li');
        li.innerHTML = `
          <span class="err-ts">${fmtTs(e.ts)}</span>
          <span><span class="err-model">${escapeText(modelBrand(e.model).displayName)}</span> · <span class="err-msg">${escapeText(e.message)}</span></span>
        `;
        errorLogList.appendChild(li);
      }
    }
  }

  function escapeText(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  async function fetchAndRenderStats() {
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'getStats' });
      if (resp?.success) renderStats(resp.data);
    } catch (_) {}
  }

  refreshStatsBtn?.addEventListener('click', fetchAndRenderStats);
  resetStatsBtn?.addEventListener('click', async () => {
    if (!confirm('确定重置所有统计数据？(不影响缓存、不影响设置)')) return;
    await chrome.runtime.sendMessage({ action: 'resetStats' });
    await fetchAndRenderStats();
  });

  fetchAndRenderStats();
  // 切到统计 tab 时立即刷新；停留在该 tab 时每 3s 自动刷新
  let statsTimer = null;
  function onTabSwitch(tab) {
    if (tab === 'stats') {
      fetchAndRenderStats();
      if (!statsTimer) statsTimer = setInterval(fetchAndRenderStats, 3000);
    } else if (statsTimer) {
      clearInterval(statsTimer);
      statsTimer = null;
    }
  }

  // ===== Tabs =====
  const tabButtons = document.querySelectorAll<HTMLButtonElement>('.tab-button');
  const tabPanels = document.querySelectorAll<HTMLElement>('.tab-panel');
  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      tabButtons.forEach(b => b.classList.toggle('active', b.dataset.tab === target));
      tabPanels.forEach(p => p.classList.toggle('active', p.dataset.panel === target));
      onTabSwitch(target || '');
    });
  });

  // ===== Hedged delay readout（展示当前后台测得的 p95） =====
  async function refreshHedgedReadout() {
    const mode = hedgedDelayModeSelect.value;
    if (mode !== 'auto') {
      hedgedDelayReadout.textContent = `固定延迟：${mode === '0' ? '即时并发' : `主请求发出 ${mode}ms 后启动兜底`}`;
      return;
    }
    // 向 background 查询当前的自适应延迟（若还没样本则返回 500ms fallback）
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'getHedgeStats' });
      if (resp?.success) {
        const { p95Ms, samples, floorMs, ceilingMs } = resp.data;
        if (samples > 0) {
          hedgedDelayReadout.textContent = `自适应当前值：${Math.round(p95Ms)}ms（主 API 最近 ${samples} 次 RTT 的 p95，夹在 ${floorMs}–${ceilingMs}ms 之间）`;
        } else {
          hedgedDelayReadout.textContent = `自适应：样本不足，暂用 500ms 固定延迟；发过几次翻译后会自动收敛`;
        }
      }
    } catch (_) {
      hedgedDelayReadout.textContent = `自适应（background 尚未就绪）`;
    }
  }
  hedgedDelayModeSelect.addEventListener('change', refreshHedgedReadout);
  refreshHedgedReadout();
});
