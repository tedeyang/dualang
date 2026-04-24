let localConfigCache: any = null;
async function loadLocalConfig() {
  if (localConfigCache) return localConfigCache;
  try {
    const res = await fetch(chrome.runtime.getURL('config.json'));
    if (!res.ok) return {};
    localConfigCache = await res.json();
    return localConfigCache;
  } catch (e) {
    return {};
  }
}

// 超级精翻专用：优先 config.json 的 moonshot key，其次当前主设置里的 key（若 baseUrl 是 moonshot）。
export async function getMoonshotKey(): Promise<string> {
  const cfg = await loadLocalConfig();
  const fromConfig = cfg?.providers?.moonshot?.apiKey || '';
  if (fromConfig) return fromConfig;
  const s = await chrome.storage.sync.get({ baseUrl: '', apiKey: '' });
  if ((s.baseUrl || '').includes('moonshot') && s.apiKey) return s.apiKey;
  return '';
}

/**
 * 通过 provider 名读取 config.json 里的 apiKey（通用版）。
 * 只在背景脚本里调用 —— content script 没有 config.json 的直接访问权限
 * （web_accessible_resources 未声明；声明了反而会让任意 X 页面能拉取到 key）。
 * Content 通过 chrome.runtime.sendMessage({ action: 'getProviderKey', provider }) 请求此接口。
 */
export async function getProviderKeyFromConfig(provider: string): Promise<string> {
  if (!provider) return '';
  const cfg = await loadLocalConfig();
  return cfg?.providers?.[provider]?.apiKey || '';
}

let settingsCache: any = null;

export function invalidateSettingsCache() {
  settingsCache = null;
}

export async function getSettings() {
  if (settingsCache) return settingsCache;
  const localConfig = await loadLocalConfig();
  const defaultApiKey = localConfig?.providers?.moonshot?.apiKey || '';
  const defaultFallbackApiKey = localConfig?.providers?.siliconflow?.apiKey || '';
  // 默认主力：SiliconFlow 免费 THUDM/GLM-4-9B-0414
  // bench v2 实测：1.9s / 质量 8.7 / 稳定性完美 / 完全免费；
  // 优于 Qwen2.5（后者 T=0.3 默认时约 30% 概率陷入退化循环）。
  // 默认思考模式：关闭 — 翻译任务不需要推理，省 token 省延迟。
  // enableStreaming / maxTokens / hedgedRequestEnabled / hedgedDelayMs 已从 UI 移除，
  // popup 打开时会从 storage 里清掉；这里不再提供默认值 —— 若内部代码需要
  // (super-fine / sampler)，它们走 Settings 对象的 in-memory 传递。
  const s = await chrome.storage.sync.get({
    apiKey: localConfig?.providers?.siliconflow?.apiKey || defaultApiKey,
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'THUDM/GLM-4-9B-0414',
    providerType: 'openai',
    reasoningEffort: 'none',
    targetLang: 'zh-CN',
    lineFusionEnabled: false,
    smartDictEnabled: false,
    fallbackEnabled: false,
    fallbackBaseUrl: 'https://api.siliconflow.cn/v1',
    fallbackApiKey: defaultFallbackApiKey,
    fallbackModel: 'THUDM/GLM-4-9B-0414',
  });
  if (!s.apiKey) s.apiKey = defaultApiKey;
  if (!s.fallbackApiKey) s.fallbackApiKey = defaultFallbackApiKey;
  settingsCache = s;
  return settingsCache;
}
