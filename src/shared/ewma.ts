/**
 * EWMA（指数加权移动平均）—— 用于路由器动态画像。
 *
 * 语义：value = alpha * sample + (1 - alpha) * value_prev
 * 冷启动：count < warmupN 时走算术平均，避免首样本被 alpha 稀释；count ≥ warmupN 切入 EWMA。
 * 序列化：所有字段都是原始类型，直接 JSON 存 chrome.storage.local。
 */

export interface EWMA {
  value: number;
  count: number;
  lastUpdateAt: number;
}

export const DEFAULT_ALPHA = 0.25;
export const DEFAULT_WARMUP = 4;

export function createEWMA(initial?: number): EWMA {
  return {
    value: typeof initial === 'number' ? initial : 0,
    count: typeof initial === 'number' ? 1 : 0,
    lastUpdateAt: Date.now(),
  };
}

export function updateEWMA(
  prev: EWMA,
  sample: number,
  alpha: number = DEFAULT_ALPHA,
  warmupN: number = DEFAULT_WARMUP,
): EWMA {
  if (!Number.isFinite(sample)) return prev;
  const count = prev.count + 1;
  let value: number;
  if (prev.count < warmupN) {
    // 算术平均：value_new = (value_prev * count_prev + sample) / count
    value = (prev.value * prev.count + sample) / count;
  } else {
    value = alpha * sample + (1 - alpha) * prev.value;
  }
  return { value, count, lastUpdateAt: Date.now() };
}

/** 读取时对未采样（count=0）返回 fallback，避免下游拿到 0 做除法。 */
export function readEWMA(e: EWMA | undefined, fallback: number): number {
  if (!e || e.count === 0) return fallback;
  return e.value;
}
