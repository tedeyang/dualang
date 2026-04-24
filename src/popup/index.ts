import { getModelMeta } from '../shared/model-meta';
import { MODEL_PRESETS, detectPreset as detectPresetShared } from '../shared/model-presets';
import { runMigration } from '../background/router/migration';
import {
  getCustomPrompts,
  saveCustomPrompts,
  DEFAULT_PROMPTS,
  type CustomPrompts,
} from '../background/custom-prompts';
import { UI_LANGS, type UiLang } from '../shared/i18n';
import { t } from '../shared/i18n-popup';
import { applyI18n, setUiLang, getUiLang } from './i18n-apply';
import { log } from '../shared/logger';
import { initProvidersTab } from './providers-tab';

// popup DOM 是静态的；找不到就是 HTML/bundle 不对应，快速失败比到处 null 检查更清晰
function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`popup: #${id} not found`);
  return el as T;
}

document.addEventListener('DOMContentLoaded', async () => {
  const reasoningEffortSelect = byId<HTMLSelectElement>('reasoningEffort');
  const targetLangSelect = byId<HTMLSelectElement>('targetLang');
  const smartDictCheckbox = byId<HTMLInputElement>('smartDictEnabled');
  const errorBanner = byId<HTMLDivElement>('errorBanner');
  const saveBtn = byId<HTMLButtonElement>('saveBtn');
  const statusDiv = byId<HTMLDivElement>('status');

  // ===== autoTranslate segment buttons =====
  const autoTranslateSeg = byId<HTMLDivElement>('autoTranslateSeg');
  const autoBtns = Array.from(autoTranslateSeg.querySelectorAll<HTMLButtonElement>('.seg-btn'));
  let currentAutoTranslate = true;

  function setAutoTranslate(auto: boolean) {
    currentAutoTranslate = auto;
    autoBtns.forEach(b => b.classList.toggle('active', b.dataset.auto === String(auto)));
  }

  autoBtns.forEach(btn => {
    btn.addEventListener('click', () => setAutoTranslate(btn.dataset.auto === 'true'));
  });

  // ===== Display mode segment buttons =====
  // 3 主选项（covers / append / contrast）+ 2 sub 选项（按行交替 下的 高亮原文 / 高亮翻译）
  // 联合映射到 displayMode + lineFusionEnabled：
  //   覆盖原文            → { displayMode: 'translation-only', lineFusionEnabled: false }
  //   整段追加            → { displayMode: 'append',           lineFusionEnabled: false }
  //   按行交替 + 高亮原文  → { displayMode: 'append',           lineFusionEnabled: true  }
  //   按行交替 + 高亮翻译  → { displayMode: 'bilingual',        lineFusionEnabled: true  }
  //   legacy 'inline'     → 视作 按行交替 + 高亮原文 (下次保存自动归一化)
  const displaySegment = byId<HTMLDivElement>('displaySegment');
  const contrastStyleRow = byId<HTMLDivElement>('contrastStyleRow');
  const mainBtns = Array.from(displaySegment.querySelectorAll<HTMLButtonElement>('.seg-btn'));
  const styleBtns = Array.from(contrastStyleRow.querySelectorAll<HTMLButtonElement>('.seg-btn'));

  type MainMode = 'translation-only' | 'append' | 'contrast';
  type ContrastStyle = 'append' | 'bilingual';
  let currentMain: MainMode = 'append';
  let currentContrastStyle: ContrastStyle = 'append';

  function setMain(mode: MainMode) {
    currentMain = mode;
    mainBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    contrastStyleRow.style.display = mode === 'contrast' ? '' : 'none';
    if (mode === 'contrast') {
      styleBtns.forEach(b => b.classList.toggle('active', b.dataset.style === currentContrastStyle));
    }
  }

  function setContrastStyle(style: ContrastStyle) {
    currentContrastStyle = style;
    styleBtns.forEach(b => b.classList.toggle('active', b.dataset.style === style));
  }

  mainBtns.forEach(btn => {
    btn.addEventListener('click', () => setMain(btn.dataset.mode as MainMode));
  });

  styleBtns.forEach(btn => {
    btn.addEventListener('click', () => setContrastStyle(btn.dataset.style as ContrastStyle));
  });

  // 从 storage 状态派生 UI 选中项
  function applyStoredDisplayState(displayMode: string, lineFusionEnabled: boolean) {
    if (displayMode === 'translation-only') {
      setMain('translation-only');
    } else if (displayMode === 'bilingual') {
      setContrastStyle('bilingual');
      setMain('contrast');
    } else if (displayMode === 'inline') {
      // 旧的 inline 模式：迁移到 按行交替 + 高亮原文
      setContrastStyle('append');
      setMain('contrast');
    } else if (lineFusionEnabled) {
      // append + lineFusion=true
      setContrastStyle('append');
      setMain('contrast');
    } else {
      // append + lineFusion=false（默认）
      setMain('append');
    }
  }

  // UI 选中项派生回 storage 字段
  function deriveDisplaySettings(): { displayMode: string; lineFusionEnabled: boolean } {
    if (currentMain === 'translation-only') {
      return { displayMode: 'translation-only', lineFusionEnabled: false };
    }
    if (currentMain === 'append') {
      return { displayMode: 'append', lineFusionEnabled: false };
    }
    // currentMain === 'contrast'
    if (currentContrastStyle === 'bilingual') {
      return { displayMode: 'bilingual', lineFusionEnabled: true };
    }
    return { displayMode: 'append', lineFusionEnabled: true };
  }

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

  // 读取存储（含旧 provider 字段，仅用于一次性 router 迁移；不再展示到 UI）
  const settings = await chrome.storage.sync.get({
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: localConfig?.providers?.siliconflow?.apiKey || localConfig?.providers?.moonshot?.apiKey || '',
    model: 'THUDM/GLM-4-9B-0414',
    providerType: 'openai',
    reasoningEffort: 'none',
    targetLang: 'zh-CN',
    autoTranslate: true,
    displayMode: null,
    bilingualMode: false,
    lineFusionEnabled: false,
    smartDictEnabled: false,
    fallbackEnabled: false,
    fallbackBaseUrl: 'https://api.siliconflow.cn/v1',
    fallbackApiKey: localConfig?.providers?.siliconflow?.apiKey || '',
    fallbackModel: 'THUDM/GLM-4-9B-0414',
    uiLang: null,  // null = 未设 → 首次按浏览器语言自动检测
  });

  // 应用 UI 语言：优先用户存的 uiLang，缺省走浏览器语言检测（i18n-apply 模块默认已做）
  const uiLangSelect = byId<HTMLSelectElement>('uiLang');
  let currentUiLang: UiLang = (UI_LANGS.find((l) => l.code === settings.uiLang)?.code) || getUiLang();
  setUiLang(currentUiLang);
  uiLangSelect.value = currentUiLang;
  applyI18n();

  reasoningEffortSelect.value = settings.reasoningEffort;
  targetLangSelect.value = settings.targetLang;
  setAutoTranslate(settings.autoTranslate !== false);
  smartDictCheckbox.checked = !!settings.smartDictEnabled;

  // 切换界面语言：即时应用 + 写 storage 让 content 侧同步；并刷新动态文本
  uiLangSelect.addEventListener('change', async () => {
    currentUiLang = uiLangSelect.value as UiLang;
    setUiLang(currentUiLang);
    applyI18n();
    // prompt description 是 JS 动态填的，applyI18n 照顾不到；这里手动刷新
    try {
      const selectedKey = promptSelect?.value as keyof CustomPrompts;
      if (selectedKey) promptDescriptionEl.textContent = t(PROMPT_DESC_KEYS[selectedKey], currentUiLang);
    } catch {}
    await chrome.storage.sync.set({ uiLang: currentUiLang });
  });

  // 一次性清理：已废弃的字段 —— 从 storage 彻底删除，避免 background 路径上
  // `settings.maxTokens` / `settings.enableStreaming` / `settings.hedgedRequestEnabled`
  // 仍被老 compute/gate 逻辑感知。程序化的内部 override（super-fine / sampler）
  // 走 Settings 对象的 in-memory 传递，不依赖 storage。
  chrome.storage.sync.remove([
    'maxTokens', 'enableStreaming', 'hedgedRequestEnabled', 'hedgedDelayMs',
  ]).catch(() => {});

  // 迁移：displayMode 未设 + 老 bilingualMode=true → 'inline' → 映射到 按行交替+高亮原文
  const VALID_DISPLAY_MODES = ['append', 'translation-only', 'inline', 'bilingual'];
  const resolvedDisplayMode = VALID_DISPLAY_MODES.includes(settings.displayMode)
    ? settings.displayMode
    : (settings.bilingualMode ? 'inline' : 'append');
  applyStoredDisplayState(resolvedDisplayMode, !!settings.lineFusionEnabled);

  // 触发路由器数据迁移（幂等；第一次打开 popup 时把旧 settings + config.json 喂入）
  try {
    await runMigration(
      {
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.model,
        fallbackEnabled: settings.fallbackEnabled,
        fallbackApiKey: settings.fallbackApiKey,
        fallbackBaseUrl: settings.fallbackBaseUrl,
        fallbackModel: settings.fallbackModel,
      },
      localConfig || {},
    );
  } catch (e) {
    log.warn('router.migration.skipped', { error: (e as Error)?.message || String(e) });
  }

  saveBtn.addEventListener('click', async () => {
    const { displayMode, lineFusionEnabled } = deriveDisplaySettings();

    await chrome.storage.sync.set({
      reasoningEffort: reasoningEffortSelect.value,
      targetLang: targetLangSelect.value,
      autoTranslate: currentAutoTranslate,
      displayMode,
      lineFusionEnabled,
      bilingualMode: false,
      smartDictEnabled: smartDictCheckbox.checked,
    });

    // 保存时清除旧的错误状态（用户已知晓）
    await chrome.storage.local.remove('dualang_error_v1');
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
    errorBanner.style.display = 'none';

    showStatus(t('common.saveOk', currentUiLang), 'success');
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
  const statTotalReqs = document.getElementById('statTotalReqs');
  const statTotalTokens = document.getElementById('statTotalTokens');
  const statCacheHitRate = document.getElementById('statCacheHitRate');
  const modelStatsList = document.getElementById('modelStatsList');
  const routerHealthList = document.getElementById('routerHealthList');
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

  function modelBrand(modelKey: string) {
    const m = String(modelKey || '').toLowerCase();
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

  function circuitBadgeHtml(circuit: any): string {
    if (!circuit) return '<span class="circuit-badge circuit-badge--unknown">未测</span>';
    const state: string = circuit.state;
    if (state === 'HEALTHY') return '<span class="circuit-badge circuit-badge--healthy">HEALTHY</span>';
    if (state === 'PROBING') return '<span class="circuit-badge circuit-badge--probing">PROBING</span>';
    if (state === 'COOLING') {
      const mins = Math.max(0, Math.ceil((circuit.cooldownUntil - Date.now()) / 60_000));
      return `<span class="circuit-badge circuit-badge--cooling">COOLING${mins > 0 ? ' ' + mins + 'min' : ''}</span>`;
    }
    if (state === 'PERMANENT_DISABLED') return '<span class="circuit-badge circuit-badge--disabled">DISABLED</span>';
    return `<span class="circuit-badge circuit-badge--unknown">${escapeText(state)}</span>`;
  }

  function fmtEWMA(ewma: any, pct = false): string {
    if (!ewma || ewma.count === 0) return '–';
    return pct ? (ewma.value * 100).toFixed(0) + '%' : Math.round(ewma.value).toString();
  }

  function bestRttEWMA(rttMs: any): number | null {
    if (!rttMs) return null;
    for (const tier of ['short', 'medium', 'long']) {
      if (rttMs[tier]?.count > 0) return Math.round(rttMs[tier].value);
    }
    return null;
  }

  function renderRouterHealth(data: any) {
    if (!routerHealthList) return;
    const providers: any[] = data?.providers || [];
    if (!providers.length) {
      routerHealthList.innerHTML = '<div class="stats-empty">暂无 Provider 数据</div>';
      return;
    }
    routerHealthList.innerHTML = '';
    for (const p of providers) {
      const rtt = bestRttEWMA(p.performance?.rttMs);
      const qualScore = p.performance?.qualityScore;
      const succRate = p.performance?.successRate;
      const probeInfo = p.circuit?.state === 'PROBING'
        ? `<span>探针 <strong>${((p.circuit.probeWeight || 0) * 100).toFixed(0)}%</strong></span>`
        : '';
      const row = document.createElement('div');
      row.className = 'rh-row';
      row.innerHTML = `
        <div class="rh-row__head">
          ${circuitBadgeHtml(p.circuit)}
          <span class="rh-row__label" title="${escapeText(p.model)}">${escapeText(p.label)}</span>
        </div>
        <div class="rh-row__metrics">
          <span>质量 <strong>${fmtEWMA(qualScore, true)}</strong></span>
          <span>成功 <strong>${fmtEWMA(succRate, true)}</strong></span>
          <span>RTT <strong>${rtt === null ? '–' : rtt + 'ms'}</strong></span>
          ${probeInfo}
        </div>
      `;
      routerHealthList.appendChild(row);
    }
  }

  async function fetchAndRenderStats() {
    try {
      const [statsResp, routerResp] = await Promise.all([
        chrome.runtime.sendMessage({ action: 'getStats' }),
        chrome.runtime.sendMessage({ action: 'getRouterStats' }),
      ]);
      if (statsResp?.success) renderStats(statsResp.data);
      if (routerResp?.success) renderRouterHealth(routerResp.data);
    } catch (_) {}
  }

  refreshStatsBtn?.addEventListener('click', fetchAndRenderStats);
  resetStatsBtn?.addEventListener('click', async () => {
    if (!confirm(t('stats.resetConfirm', currentUiLang))) return;
    await chrome.runtime.sendMessage({ action: 'resetStats' });
    await fetchAndRenderStats();
  });

  fetchAndRenderStats();
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
  let providersInited = false;
  const tabButtons = document.querySelectorAll<HTMLButtonElement>('.tab-button');
  const tabPanels = document.querySelectorAll<HTMLElement>('.tab-panel');
  tabButtons.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const target = btn.dataset.tab;
      tabButtons.forEach(b => b.classList.toggle('active', b.dataset.tab === target));
      tabPanels.forEach(p => p.classList.toggle('active', p.dataset.panel === target));
      onTabSwitch(target || '');
      if (target === 'providers' && !providersInited) {
        providersInited = true;
        try { await initProvidersTab(); }
        catch (e) { log.warn('providers-tab.init.fail', { error: (e as Error)?.message || String(e) }); }
      }
    });
  });

  // ===== 自定义 system prompt =====
  // 3 段可改: translationRules / strict / boost。dropdown 选哪段、textarea 编辑当前段；
  // 全部段的当前值（含未保存编辑）都缓存在 currentValues 里，保存时统一持久化。
  const PROMPT_KEYS: Array<keyof CustomPrompts> = ['translationRules', 'strict', 'boost'];
  const PROMPT_DESC_KEYS: Record<keyof CustomPrompts, string> = {
    translationRules: 'advanced.promptDescTransRules',
    strict: 'advanced.promptDescStrict',
    boost: 'advanced.promptDescBoost',
  };
  const promptSelect = byId<HTMLSelectElement>('promptSelect');
  const promptEditor = byId<HTMLTextAreaElement>('promptEditor');
  const promptDescriptionEl = byId<HTMLParagraphElement>('promptDescription');
  const promptResetBtn = byId<HTMLButtonElement>('promptResetBtn');
  const promptDirtyBadge = byId<HTMLSpanElement>('promptDirtyBadge');

  const customPrompts = await getCustomPrompts();
  // 内存里维持每段当前值（custom 优先，否则默认）；切换 dropdown 时填回 textarea
  const currentValues: Record<keyof CustomPrompts, string> = {
    translationRules: customPrompts.translationRules ?? DEFAULT_PROMPTS.translationRules,
    strict: customPrompts.strict ?? DEFAULT_PROMPTS.strict,
    boost: customPrompts.boost ?? DEFAULT_PROMPTS.boost,
  };

  function showPrompt(key: keyof CustomPrompts) {
    promptEditor.value = currentValues[key];
    promptDescriptionEl.textContent = t(PROMPT_DESC_KEYS[key], currentUiLang);
    promptDirtyBadge.style.display =
      currentValues[key] !== DEFAULT_PROMPTS[key] ? '' : 'none';
  }

  promptSelect.addEventListener('change', () => {
    showPrompt(promptSelect.value as keyof CustomPrompts);
  });

  promptEditor.addEventListener('input', () => {
    const key = promptSelect.value as keyof CustomPrompts;
    currentValues[key] = promptEditor.value;
    promptDirtyBadge.style.display =
      currentValues[key] !== DEFAULT_PROMPTS[key] ? '' : 'none';
  });

  promptResetBtn.addEventListener('click', () => {
    const key = promptSelect.value as keyof CustomPrompts;
    currentValues[key] = DEFAULT_PROMPTS[key];
    promptEditor.value = DEFAULT_PROMPTS[key];
    promptDirtyBadge.style.display = 'none';
  });

  // 初次显示
  showPrompt(promptSelect.value as keyof CustomPrompts);

  // 保存时持久化所有 3 段；与默认相同的会被剔除，只存用户真改过的
  async function persistCustomPrompts() {
    const next: CustomPrompts = {};
    for (const key of PROMPT_KEYS) {
      const v = currentValues[key];
      if (v && v !== DEFAULT_PROMPTS[key]) next[key] = v;
    }
    await saveCustomPrompts(next);
  }
  saveBtn.addEventListener('click', () => {
    persistCustomPrompts().catch((e) => log.warn('customPrompts.save.fail', { error: (e as Error)?.message || String(e) }));
  });

  // ===== 清除翻译缓存 =====
  const clearCacheBtn = document.getElementById('clearCacheBtn') as HTMLButtonElement | null;
  clearCacheBtn?.addEventListener('click', async () => {
    if (!confirm(t('advanced.clearCacheConfirm', currentUiLang))) return;
    clearCacheBtn.disabled = true;
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'clearCache' });
      if (resp?.success) {
        showStatus(t('advanced.clearCacheOk', currentUiLang), 'success');
      } else {
        showStatus(t('advanced.clearCacheFail', currentUiLang), 'error');
      }
    } catch (e: any) {
      showStatus(t('advanced.clearCacheFail', currentUiLang) + ': ' + (e?.message || e), 'error');
    } finally {
      clearCacheBtn.disabled = false;
    }
  });
});
