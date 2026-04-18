import { normalizeText } from '../shared/types';

const CACHE_KEY = 'dualang_cache_v1';
const CACHE_MAX_SIZE = 5000;
const MEM_CACHE_MAX = 2000;
const memCacheMap = new Map();

function memCacheGet(hash: string) {
  if (!memCacheMap.has(hash)) return null;
  const entry = memCacheMap.get(hash);
  memCacheMap.delete(hash);
  memCacheMap.set(hash, entry);
  return entry;
}

function memCacheSet(hash: string, entry: any) {
  if (memCacheMap.has(hash)) memCacheMap.delete(hash);
  else if (memCacheMap.size >= MEM_CACHE_MAX) {
    memCacheMap.delete(memCacheMap.keys().next().value);
  }
  memCacheMap.set(hash, entry);
}

export async function getCache(hash: string) {
  const mem = memCacheGet(hash);
  if (mem) return mem;

  const record = await chrome.storage.local.get(CACHE_KEY);
  const cache = record[CACHE_KEY] || {};
  const entry = cache[hash] || null;
  if (entry) memCacheSet(hash, entry);
  return entry;
}

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

  await chrome.storage.local.set({ [CACHE_KEY]: cache });
}

function computeHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
  }
  return String(hash >>> 0);
}

export function cacheKey(text: string, lang: string, model: string, baseUrl: string): string {
  return computeHash(normalizeText(text) + '|' + lang + '|' + model + '|' + baseUrl);
}
