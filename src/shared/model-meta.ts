// 模型 → 品牌/图标/介绍/点击跳转 URL 的映射
// 在 content script 里用，通过 chrome.runtime.getURL 解析到 chrome-extension:// URL
// （要求 manifest 声明 web_accessible_resources）
//
// 提供方资料：
//   - Moonshot Kimi:  https://platform.moonshot.cn/
//   - SiliconFlow:    https://siliconflow.cn/pricing (GLM-4-9B 等免费托管入口)
//   - 通义千问 Qwen:  https://chat.qwen.ai/ (图标来自 chat.qwen.ai，SiliconFlow 上的 Qwen 模型仍归属阿里品牌)
//   - 智谱 z.ai:      https://z.ai/
//   - Chrome 内置:    https://developer.chrome.com/docs/ai/translator-api  (138+, 桌面)
//   - Edge 内置:      https://learn.microsoft.com/en-us/microsoft-edge/web-platform/translator-api  (Canary 143+)

export type ModelMeta = {
  modelName: string;          // 显示名：'Kimi (Moonshot)' / 'GLM (z.ai)'
  modelDescription: string;   // 悬浮提示一句话
  iconUrl: string;            // chrome.runtime.getURL('icons/xxx.png|svg')
  apiDeployUrl: string;       // 点击后打开的 API 部署/控制台页面
};

/**
 * 根据 settings.model 和 settings.baseUrl 判定品牌。
 * 规则：
 *   - 模型名决定品牌图标（GLM 永远用 z.ai 图标，无论它托管在哪里）
 *   - baseUrl 决定"点击跳去的部署站"（模型托管方的控制台）
 */
export function getModelMeta(model: string, baseUrl: string): ModelMeta {
  const m = (model || '').toLowerCase();
  const b = (baseUrl || '').toLowerCase();

  // 浏览器本地翻译：按运行时 UA 区分 Chrome / Edge
  if (m === 'browser-native' || b.startsWith('browser://translator')) {
    const isEdge = typeof navigator !== 'undefined' && /Edg\//.test(navigator.userAgent || '');
    if (isEdge) {
      return {
        modelName: 'Microsoft Edge 本地翻译',
        modelDescription: 'Edge 内置 Translator API — 完全离线、无需 API Key',
        iconUrl: chrome.runtime.getURL('icons/edge.svg'),
        apiDeployUrl: 'https://www.microsoft.com/edge/',
      };
    }
    return {
      modelName: 'Google Chrome 本地翻译',
      modelDescription: 'Chrome 内置 Translator API — 完全离线、无需 API Key',
      iconUrl: chrome.runtime.getURL('icons/chrome.svg'),
      apiDeployUrl: 'https://www.google.com/chrome/',
    };
  }

  // 点击目标：服务方的品牌官网首页（不是控制台/平台页）
  let apiDeployUrl = b ? safeOrigin(baseUrl) : 'https://openai.com/';
  if (b.includes('moonshot') || b.includes('kimi')) apiDeployUrl = 'https://kimi.com/';
  else if (b.includes('siliconflow')) apiDeployUrl = 'https://siliconflow.cn/';
  else if (b.includes('z.ai') || b.includes('bigmodel')) apiDeployUrl = 'https://z.ai/';

  // 品牌图标：模型作者方
  if (m.includes('kimi') || m.includes('moonshot')) {
    return {
      modelName: `Kimi · ${model}`,
      modelDescription: '月之暗面 Kimi — 长上下文中文对话大模型',
      iconUrl: chrome.runtime.getURL('icons/kimi.png'),
      apiDeployUrl,
    };
  }
  if (m.includes('qwen')) {
    return {
      modelName: `Qwen · ${model}`,
      modelDescription: '阿里通义千问 — 开源中英文通用大模型',
      iconUrl: chrome.runtime.getURL('icons/qwen.png'),
      apiDeployUrl: 'https://chat.qwen.ai/',
    };
  }
  if (m.includes('glm')) {
    return {
      modelName: `GLM · ${model}`,
      modelDescription: '清华智谱 GLM — 通用大模型（z.ai）',
      iconUrl: chrome.runtime.getURL('icons/zai.svg'),
      apiDeployUrl,
    };
  }
  // 未知模型：用托管方（baseUrl）的图标
  if (b.includes('siliconflow')) {
    return {
      modelName: model || 'SiliconFlow',
      modelDescription: 'SiliconFlow 托管 — 多模型统一入口',
      iconUrl: chrome.runtime.getURL('icons/siliconflow.png'),
      apiDeployUrl,
    };
  }
  // 真·未知：用扩展 48px 默认图标占位
  return {
    modelName: model || '未知模型',
    modelDescription: baseUrl ? `通过 ${safeHost(baseUrl)} 调用` : '未配置 API',
    iconUrl: chrome.runtime.getURL('icons/icon48.png'),
    apiDeployUrl,
  };
}

function safeHost(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function safeOrigin(url: string): string {
  try { return new URL(url).origin + '/'; } catch { return url; }
}
