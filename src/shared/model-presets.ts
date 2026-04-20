/**
 * 预设模型列表 —— popup 和浮球共用。
 * 改动这里影响两处 UI；新增 provider 只需在这里加一条 + （如需）src/background/profiles.ts
 * 对应 profile。
 */

export interface ModelPreset {
  /** 唯一 key，popup 下拉 option.value / 浮球 model-list key */
  key: string;
  /** 面板展示用的短名（包含图标会另取 model-meta.ts） */
  displayName: string;
  /** OpenAI-compatible API 根路径 */
  baseUrl: string;
  /** 模型 id（要和 profiles.ts 的 matchModel 对齐） */
  model: string;
  /** provider 的 config.json 键（用于在 popup 加载时自动填 apiKey） */
  provider: 'moonshot' | 'siliconflow' | string;
  providerType: 'openai';
}

export const MODEL_PRESETS: ModelPreset[] = [
  {
    key: 'siliconflow-glm-4-9b',
    displayName: 'GLM-4-9B',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'THUDM/GLM-4-9B-0414',
    provider: 'siliconflow',
    providerType: 'openai',
  },
  {
    key: 'siliconflow-qwen3-8b',
    displayName: 'Qwen3-8B',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen3-8B',
    provider: 'siliconflow',
    providerType: 'openai',
  },
  {
    key: 'siliconflow-qwen2.5-7b',
    displayName: 'Qwen2.5-7B',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    provider: 'siliconflow',
    providerType: 'openai',
  },
  {
    key: 'moonshot-k2.5',
    displayName: 'Kimi k2.5',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2.5',
    provider: 'moonshot',
    providerType: 'openai',
  },
  {
    key: 'moonshot-v1-8k',
    displayName: 'Moonshot v1 8k',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    provider: 'moonshot',
    providerType: 'openai',
  },
];

/** 按 baseUrl + model 反查 preset；找不到返回 undefined（用户自定义模型）*/
export function detectPreset(baseUrl: string, model: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((p) => p.baseUrl === baseUrl && p.model === model);
}

/** 用 model key 取 preset */
export function getPreset(key: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((p) => p.key === key);
}
