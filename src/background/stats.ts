// 插件运行统计：按模型聚合请求次数 / 成功率 / RTT / tokens 消耗，
// 外加缓存命中数、质量重试数、最近错误列表。
// 数据持久化到 chrome.storage.local（防 SW 重启丢失），写入 debounce 2s。
//
// 供 popup 的"统计"tab 展示；不依赖任何第三方指标系统。

const STATS_KEY = 'dualang_stats_v1';
const MAX_ERRORS = 20;
const PERSIST_DEBOUNCE_MS = 2000;

export type ModelStats = {
  reqs: number;
  successes: number;
  failures: number;
  rttTotalMs: number;
  rttCount: number;
  rttMinMs: number;   // Infinity 初始
  rttMaxMs: number;
  tokensPrompt: number;
  tokensCompletion: number;
  tokensTotal: number;
  lastUsedAt: number;
};

export type ErrorEntry = {
  ts: number;
  model: string;
  message: string;
};

export type Stats = {
  models: Record<string, ModelStats>;
  cacheHits: number;
  qualityRetries: number;
  errors: ErrorEntry[];
  startedAt: number;
};

function newModelStats(): ModelStats {
  return {
    reqs: 0, successes: 0, failures: 0,
    rttTotalMs: 0, rttCount: 0,
    rttMinMs: Infinity, rttMaxMs: 0,
    tokensPrompt: 0, tokensCompletion: 0, tokensTotal: 0,
    lastUsedAt: 0,
  };
}

function defaultStats(): Stats {
  return { models: {}, cacheHits: 0, qualityRetries: 0, errors: [], startedAt: Date.now() };
}

let memStats: Stats = defaultStats();
let loaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

async function load() {
  const data = await chrome.storage.local.get(STATS_KEY);
  const stored = data[STATS_KEY];
  if (stored && typeof stored === 'object') {
    memStats = { ...defaultStats(), ...stored };
    if (!memStats.models) memStats.models = {};
    if (!Array.isArray(memStats.errors)) memStats.errors = [];
  }
  loaded = true;
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    await chrome.storage.local.set({ [STATS_KEY]: memStats });
  }, PERSIST_DEBOUNCE_MS);
}

async function ensureLoaded() {
  if (!loaded) await load();
}

/** 归一化模型 key —— 浏览器本地翻译统一算 'browser-native'，避免 Chrome/Edge 分开统计 */
function normalizeModelKey(model: string | undefined): string {
  if (!model) return 'unknown';
  if (model === 'browser-native') return 'browser-native';
  return model;
}

export async function recordRequest(
  model: string | undefined,
  ok: boolean,
  rttMs: number,
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
) {
  await ensureLoaded();
  const key = normalizeModelKey(model);
  const m = memStats.models[key] || newModelStats();
  m.reqs++;
  if (ok) m.successes++;
  else m.failures++;
  if (Number.isFinite(rttMs) && rttMs >= 0) {
    m.rttTotalMs += rttMs;
    m.rttCount++;
    if (rttMs < m.rttMinMs) m.rttMinMs = rttMs;
    if (rttMs > m.rttMaxMs) m.rttMaxMs = rttMs;
  }
  if (usage) {
    m.tokensPrompt += usage.prompt_tokens || 0;
    m.tokensCompletion += usage.completion_tokens || 0;
    m.tokensTotal += usage.total_tokens || 0;
  }
  m.lastUsedAt = Date.now();
  memStats.models[key] = m;
  schedulePersist();
}

export async function recordCacheHit(count = 1) {
  await ensureLoaded();
  memStats.cacheHits += count;
  schedulePersist();
}

export async function recordQualityRetry() {
  await ensureLoaded();
  memStats.qualityRetries++;
  schedulePersist();
}

export async function recordError(model: string | undefined, message: string) {
  await ensureLoaded();
  memStats.errors.unshift({
    ts: Date.now(),
    model: normalizeModelKey(model),
    message: String(message || '').slice(0, 200),
  });
  if (memStats.errors.length > MAX_ERRORS) memStats.errors.length = MAX_ERRORS;
  schedulePersist();
}

export async function getStats(): Promise<Stats> {
  await ensureLoaded();
  return memStats;
}

export async function resetStats() {
  memStats = defaultStats();
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  await chrome.storage.local.set({ [STATS_KEY]: memStats });
}
