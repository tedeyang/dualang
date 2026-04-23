/**
 * 路由器存储适配器。
 * sync 存轻量可同步的（providers 名单、routing 设置），local 存量大或敏感的（apiKey、画像、熔断）。
 *
 * 所有 setter 做 full-overwrite（单 key 存整个对象），避免 RMW 竞态。
 * 读侧做 in-memory shallow cache，onChanged 监听失效。
 */

import {
  STORAGE_KEYS,
  type ProviderEntry,
  type ProviderCapability,
  type PerformanceProfile,
  type LimitProfile,
  type CircuitRecord,
  type RoutingSettings,
  defaultRoutingSettings,
} from '../../shared/router-types';

type StorageArea = 'sync' | 'local';

const cache: Record<string, any> = Object.create(null);
let listenerAttached = false;

function attachListenerOnce() {
  if (listenerAttached) return;
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return;
  chrome.storage.onChanged.addListener((changes) => {
    for (const key of Object.keys(changes)) {
      delete cache[key];
    }
  });
  listenerAttached = true;
}

async function readRaw<T>(area: StorageArea, key: string, fallback: T): Promise<T> {
  attachListenerOnce();
  if (key in cache) return cache[key];
  const got = await chrome.storage[area].get({ [key]: fallback });
  cache[key] = got[key];
  return cache[key] as T;
}

async function writeRaw<T>(area: StorageArea, key: string, value: T): Promise<void> {
  await chrome.storage[area].set({ [key]: value });
  cache[key] = value;
}

// ============ providers[] (sync) ============

export async function listProviders(): Promise<ProviderEntry[]> {
  return readRaw<ProviderEntry[]>('sync', STORAGE_KEYS.providers, []);
}

export async function saveProviders(list: ProviderEntry[]): Promise<void> {
  await writeRaw('sync', STORAGE_KEYS.providers, list);
}

export async function upsertProvider(entry: ProviderEntry): Promise<void> {
  const list = await listProviders();
  const idx = list.findIndex((p) => p.id === entry.id);
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  await saveProviders(list);
}

export async function deleteProvider(id: string): Promise<void> {
  const list = await listProviders();
  const next = list.filter((p) => p.id !== id);
  if (next.length === list.length) return;
  await saveProviders(next);
  // 级联：同时清本地 per-id 记录
  await Promise.all([
    deleteApiKey(id),
    deleteCapability(id),
    deletePerformance(id),
    deleteLimits(id),
    deleteCircuit(id),
  ]);
}

// ============ routing settings (sync) ============

export async function getRoutingSettings(): Promise<RoutingSettings> {
  const raw = await readRaw<RoutingSettings | null>('sync', STORAGE_KEYS.routing, null as any);
  if (!raw) return defaultRoutingSettings();
  return { ...defaultRoutingSettings(), ...raw };
}

export async function setRoutingSettings(s: RoutingSettings): Promise<void> {
  await writeRaw('sync', STORAGE_KEYS.routing, s);
}

// ============ 通用 per-id 映射 helpers ============

async function readMap<T>(key: string): Promise<Record<string, T>> {
  return readRaw<Record<string, T>>('local', key, {});
}

async function writeMap<T>(key: string, map: Record<string, T>): Promise<void> {
  await writeRaw('local', key, map);
}

async function setInMap<T>(key: string, id: string, value: T): Promise<void> {
  const map = { ...(await readMap<T>(key)) };
  map[id] = value;
  await writeMap(key, map);
}

async function deleteFromMap(key: string, id: string): Promise<void> {
  const map = { ...(await readMap<unknown>(key)) };
  if (!(id in map)) return;
  delete map[id];
  await writeMap(key, map);
}

// ============ API keys (local) ============

export async function getApiKey(id: string): Promise<string> {
  const map = await readMap<string>(STORAGE_KEYS.apiKeys);
  return map[id] || '';
}

export async function setApiKey(id: string, key: string): Promise<void> {
  await setInMap(STORAGE_KEYS.apiKeys, id, key);
}

export async function deleteApiKey(id: string): Promise<void> {
  await deleteFromMap(STORAGE_KEYS.apiKeys, id);
}

// ============ capability / profile / limit / circuit (local) ============

export async function getCapability(id: string): Promise<ProviderCapability | undefined> {
  const map = await readMap<ProviderCapability>(STORAGE_KEYS.capabilities);
  return map[id];
}
export async function setCapability(id: string, cap: ProviderCapability): Promise<void> {
  await setInMap(STORAGE_KEYS.capabilities, id, cap);
}
export async function deleteCapability(id: string): Promise<void> {
  await deleteFromMap(STORAGE_KEYS.capabilities, id);
}

export async function getPerformance(id: string): Promise<PerformanceProfile | undefined> {
  const map = await readMap<PerformanceProfile>(STORAGE_KEYS.performance);
  return map[id];
}
export async function setPerformance(id: string, prof: PerformanceProfile): Promise<void> {
  await setInMap(STORAGE_KEYS.performance, id, prof);
}
export async function deletePerformance(id: string): Promise<void> {
  await deleteFromMap(STORAGE_KEYS.performance, id);
}

export async function getLimits(id: string): Promise<LimitProfile | undefined> {
  const map = await readMap<LimitProfile>(STORAGE_KEYS.limits);
  return map[id];
}
export async function setLimits(id: string, lim: LimitProfile): Promise<void> {
  await setInMap(STORAGE_KEYS.limits, id, lim);
}
export async function deleteLimits(id: string): Promise<void> {
  await deleteFromMap(STORAGE_KEYS.limits, id);
}

export async function getCircuit(id: string): Promise<CircuitRecord | undefined> {
  const map = await readMap<CircuitRecord>(STORAGE_KEYS.circuit);
  return map[id];
}
export async function setCircuit(id: string, rec: CircuitRecord): Promise<void> {
  await setInMap(STORAGE_KEYS.circuit, id, rec);
}
export async function deleteCircuit(id: string): Promise<void> {
  await deleteFromMap(STORAGE_KEYS.circuit, id);
}

// ============ 迁移 guard ============

export async function isMigrationDone(version: number): Promise<boolean> {
  const v = await readRaw<number>('local', STORAGE_KEYS.migrationDone, 0);
  return v >= version;
}

export async function markMigrationDone(version: number): Promise<void> {
  await writeRaw('local', STORAGE_KEYS.migrationDone, version);
}

// ============ 测试 hook ============

/** 清掉内存 cache；仅供测试使用。 */
export function __clearCacheForTest() {
  for (const k of Object.keys(cache)) delete cache[k];
}
