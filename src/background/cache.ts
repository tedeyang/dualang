import { normalizeText } from '../shared/types';

/** chrome.storage.local 里缓存数据的顶层键 */
const CACHE_KEY = 'dualang_cache_v1';
/** L2（storage）缓存条目上限；触顶时按时间戳淘汰最旧的 20%。
 * 注：chrome.storage.local 配额约 5MB，5000 条长译文容易超限。
 * 500 条足以覆盖一次重度浏览 session，L1 内存另有 2000 条热缓存兜底。
 */
const CACHE_MAX_SIZE = 500;
/** L1（内存）缓存条目上限；LRU 淘汰最久未访问项。 */
const MEM_CACHE_MAX = 2000;
const memCacheMap = new Map();

/** 清空 L1 + L2 翻译缓存（popup "清除缓存" 按钮用）；统计/画像不动 */
export async function clearAllCache(): Promise<void> {
  memCacheMap.clear();
  try {
    await chrome.storage.local.remove(CACHE_KEY);
  } catch {
    // 环境里没有 chrome.storage 时（单测）静默
  }
}

/** L1 内存缓存读取；命中后重新插入以维持 LRU 序。 */
function memCacheGet(hash: string) {
  if (!memCacheMap.has(hash)) return null;
  const entry = memCacheMap.get(hash);
  memCacheMap.delete(hash);
  memCacheMap.set(hash, entry);
  return entry;
}

/** L1 内存缓存写入；触顶时淘汰最早插入项。 */
function memCacheSet(hash: string, entry: any) {
  if (memCacheMap.has(hash)) memCacheMap.delete(hash);
  else if (memCacheMap.size >= MEM_CACHE_MAX) {
    memCacheMap.delete(memCacheMap.keys().next().value);
  }
  memCacheMap.set(hash, entry);
}

/**
 * 读取单条缓存；先查 L1 内存，miss 再查 L2 storage。
 * 命中后回写 L1，保证热点条目零 IO。
 */
export async function getCache(hash: string) {
  const mem = memCacheGet(hash);
  if (mem) return mem;

  const record = await chrome.storage.local.get(CACHE_KEY);
  const cache = record[CACHE_KEY] || {};
  const entry = cache[hash] || null;
  if (entry) memCacheSet(hash, entry);
  return entry;
}

/**
 * 批量缓存读取；先扫 L1 内存，剩余未命中的一次性读 L2 storage。
 * 比循环调用 getCache 少 N-1 次 storage IO。
 */
export async function getCacheBatch(hashes: string[]) {
  const results = new Array(hashes.length).fill(null);
  const missingIndices: number[] = [];

  for (let i = 0; i < hashes.length; i++) {
    const mem = memCacheGet(hashes[i]);
    if (mem) results[i] = mem;
    else missingIndices.push(i);
  }

  if (missingIndices.length === 0) return results;

  const record = await chrome.storage.local.get(CACHE_KEY);
  const cache = record[CACHE_KEY] || {};

  for (const idx of missingIndices) {
    const entry = cache[hashes[idx]] || null;
    if (entry) {
      results[idx] = entry;
      memCacheSet(hashes[idx], entry);
    }
  }
  return results;
}

/**
 * 写入缓存；同步更新 L1 内存 + L2 storage。
 * storage 触顶时按时间戳淘汰最旧的 20%，避免一次清理太多。
 */
export async function setCache(hash: string, value: any) {
  memCacheSet(hash, value);

  const record = await chrome.storage.local.get(CACHE_KEY);
  let cache = record[CACHE_KEY] || {};
  cache[hash] = value;

  const keys = Object.keys(cache);
  if (keys.length > CACHE_MAX_SIZE) {
    const sorted = keys.map(k => ({ key: k, ts: cache[k].ts || 0 })).sort((a, b) => a.ts - b.ts);
    const toDelete = Math.ceil(keys.length * 0.2);
    for (let i = 0; i < toDelete; i++) delete cache[sorted[i].key];
  }

  try {
    await chrome.storage.local.set({ [CACHE_KEY]: cache });
  } catch (err: any) {
    // 配额超限：激进清理 50% 最旧数据后重试一次
    if (err?.message?.includes('quota') || err?.name?.includes('Quota')) {
      const sorted = keys.map(k => ({ key: k, ts: cache[k].ts || 0 })).sort((a, b) => a.ts - b.ts);
      const toDelete = Math.ceil(keys.length * 0.5);
      for (let i = 0; i < toDelete; i++) delete cache[sorted[i].key];
      await chrome.storage.local.set({ [CACHE_KEY]: cache });
    } else {
      throw err;
    }
  }
}

/** djb2 字符串哈希；把任意长度文本映射到 32 位无符号整数。 */
function computeHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
  }
  return String(hash >>> 0);
}

/**
 * 生成缓存键；把原文（先 normalize）+ 语言 + 模型 + baseUrl 拼成唯一标识。
 * normalize 保证"前后空格不同"的同文本共享同一条缓存。
 */
export function cacheKey(text: string, lang: string, model: string, baseUrl: string): string {
  return computeHash(normalizeText(text) + '|' + lang + '|' + model + '|' + baseUrl);
}
