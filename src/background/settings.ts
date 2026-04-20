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
  const s = await chrome.storage.sync.get({
    apiKey: localConfig?.providers?.siliconflow?.apiKey || defaultApiKey,
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'THUDM/GLM-4-9B-0414',
    providerType: 'openai',           // 'openai' | 'browser-native'（后者不走 background，仅 content 用）
    enableStreaming: false,
    maxTokens: 4096,
    reasoningEffort: 'none',
    targetLang: 'zh-CN',
    fallbackEnabled: false,
    fallbackBaseUrl: 'https://api.siliconflow.cn/v1',
    fallbackApiKey: defaultFallbackApiKey,
    fallbackModel: 'THUDM/GLM-4-9B-0414',
    hedgedRequestEnabled: false
  });
  if (!s.apiKey) s.apiKey = defaultApiKey;
  if (!s.fallbackApiKey) s.fallbackApiKey = defaultFallbackApiKey;
  settingsCache = s;
  return settingsCache;
}
