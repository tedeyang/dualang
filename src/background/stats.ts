// 插件运行统计：按模型聚合请求次数 / 成功率 / RTT / tokens 消耗，
// 外加缓存命中数、质量重试数、最近错误列表。
// 数据持久化到 chrome.storage.local（防 SW 重启丢失），写入 debounce 2s。
//
// 供 popup 的"统计"tab 展示；不依赖任何第三方指标系统。

const STATS_KEY = 'dualang_stats_v1';
const MAX_ERRORS = 20;
const PERSIST_DEBOUNCE_MS = 2000;
/** 近况 RTT 窗口长度：5 分钟内的成功请求 */
const RECENT_RTT_WINDOW_MS = 5 * 60 * 1000;
/** 每个模型最多保留 100 个样本；超出按时间剪枝 */
const RECENT_RTT_MAX_SAMPLES = 100;

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
  /** 近 5 分钟的 RTT 样本（ts + rttMs），仅成功请求记录 */
  recentRtts: Array<{ ts: number; rttMs: number }>;
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
    recentRtts: [],
  };
}

/** 丢弃过期样本；采样头部即可（ts 单调递增），避免每次扫全数组 */
function pruneRecentRtts(samples: Array<{ ts: number; rttMs: number }>, now: number): Array<{ ts: number; rttMs: number }> {
  const cutoff = now - RECENT_RTT_WINDOW_MS;
  let head = 0;
  while (head < samples.length && samples[head].ts < cutoff) head++;
  if (head === 0 && samples.length <= RECENT_RTT_MAX_SAMPLES) return samples;
  const pruned = samples.slice(head);
  // 额外兜底：窗口内样本太多时裁到上限（优先保留较新的）
  if (pruned.length > RECENT_RTT_MAX_SAMPLES) {
    return pruned.slice(pruned.length - RECENT_RTT_MAX_SAMPLES);
  }
  return pruned;
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
    try {
      await chrome.storage.local.set({ [STATS_KEY]: memStats });
    } catch (err: any) {
      // 配额超限：丢弃 errors 数组兜底（统计数字比错误记录更重要）
      if (err?.message?.includes('quota') || err?.name?.includes('Quota')) {
        const trimmed = { ...memStats, errors: memStats.errors.slice(0, 5) };
        await chrome.storage.local.set({ [STATS_KEY]: trimmed });
      } else {
        throw err;
      }
    }
  }, PERSIST_DEBOUNCE_MS);
}

async function ensureLoaded() {
  if (!loaded) await load();
}

function normalizeModelKey(model: string | undefined): string {
  return model || 'unknown';
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
  if (!m.recentRtts) m.recentRtts = [];
  m.reqs++;
  if (ok) m.successes++;
  else m.failures++;
  const now = Date.now();
  if (Number.isFinite(rttMs) && rttMs >= 0) {
    m.rttTotalMs += rttMs;
    m.rttCount++;
    if (rttMs < m.rttMinMs) m.rttMinMs = rttMs;
    if (rttMs > m.rttMaxMs) m.rttMaxMs = rttMs;
    // 仅成功请求计入近况窗口（失败的 RTT 不代表"该模型有多快"）
    if (ok) {
      m.recentRtts.push({ ts: now, rttMs });
      m.recentRtts = pruneRecentRtts(m.recentRtts, now);
    }
  }
  if (usage) {
    m.tokensPrompt += usage.prompt_tokens || 0;
    m.tokensCompletion += usage.completion_tokens || 0;
    m.tokensTotal += usage.total_tokens || 0;
  }
  m.lastUsedAt = now;
  memStats.models[key] = m;
  schedulePersist();
}

/**
 * 返回每个模型最近 5 分钟的成功请求平均 RTT。
 * 用于浮球里展示 "模型名 · 1.9s"。没有样本的模型不出现在结果里。
 */
export async function getRecentRttByModel(): Promise<Record<string, { avgMs: number; samples: number }>> {
  await ensureLoaded();
  const now = Date.now();
  const out: Record<string, { avgMs: number; samples: number }> = {};
  for (const [key, m] of Object.entries(memStats.models)) {
    const samples = pruneRecentRtts(m.recentRtts || [], now);
    if (samples.length === 0) continue;
    const avgMs = samples.reduce((s, x) => s + x.rttMs, 0) / samples.length;
    out[key] = { avgMs, samples: samples.length };
  }
  return out;
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
