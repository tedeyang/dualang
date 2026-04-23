import { describe, it, expect, beforeEach, vi } from 'vitest';

// chrome.storage 内存 mock
function makeStorageArea() {
  const data: Record<string, any> = {};
  return {
    _data: data,
    get: vi.fn((keys?: any) => {
      if (keys == null) return Promise.resolve({ ...data });
      if (typeof keys === 'string') {
        return Promise.resolve({ [keys]: data[keys] });
      }
      if (Array.isArray(keys)) {
        const out: Record<string, any> = {};
        for (const k of keys) out[k] = data[k];
        return Promise.resolve(out);
      }
      // object = defaults
      const out: Record<string, any> = {};
      for (const [k, def] of Object.entries(keys)) {
        out[k] = k in data ? data[k] : def;
      }
      return Promise.resolve(out);
    }),
    set: vi.fn((obj: Record<string, any>) => {
      Object.assign(data, obj);
      return Promise.resolve();
    }),
    remove: vi.fn((k: string) => {
      delete data[k];
      return Promise.resolve();
    }),
  };
}

const syncArea = makeStorageArea();
const localArea = makeStorageArea();

(globalThis as any).chrome = {
  storage: {
    sync: syncArea,
    local: localArea,
    onChanged: { addListener: vi.fn() },
  },
};

const {
  upsertProvider,
  listProviders,
  deleteProvider,
  setApiKey,
  getApiKey,
  setCapability,
  getCapability,
  setCircuit,
  getCircuit,
  getRoutingSettings,
  setRoutingSettings,
  isMigrationDone,
  markMigrationDone,
  __clearCacheForTest,
} = await import('./storage');

function resetStorage() {
  for (const k of Object.keys(syncArea._data)) delete syncArea._data[k];
  for (const k of Object.keys(localArea._data)) delete localArea._data[k];
  __clearCacheForTest();
}

const sampleProvider = () => ({
  id: 'sf:GLM-4-9B',
  label: 'GLM-4-9B · SiliconFlow',
  baseUrl: 'https://api.siliconflow.cn/v1',
  model: 'THUDM/GLM-4-9B-0414',
  apiKeyRef: 'sf:GLM-4-9B',
  enabled: true,
  createdAt: 1_700_000_000_000,
});

describe('storage — providers CRUD', () => {
  beforeEach(resetStorage);

  it('upsert then list', async () => {
    await upsertProvider(sampleProvider());
    const list = await listProviders();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('sf:GLM-4-9B');
  });

  it('upsert updates existing by id', async () => {
    await upsertProvider(sampleProvider());
    await upsertProvider({ ...sampleProvider(), label: 'Updated' });
    const list = await listProviders();
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe('Updated');
  });

  it('delete cascades to per-id maps', async () => {
    await upsertProvider(sampleProvider());
    await setApiKey('sf:GLM-4-9B', 'sk-abc');
    await setCapability('sf:GLM-4-9B', {
      batch: 'proven',
      streaming: 'proven',
      thinkingMode: 'none',
      observedAt: 1,
    });

    await deleteProvider('sf:GLM-4-9B');

    expect(await listProviders()).toHaveLength(0);
    expect(await getApiKey('sf:GLM-4-9B')).toBe('');
    expect(await getCapability('sf:GLM-4-9B')).toBeUndefined();
  });
});

describe('storage — API key isolation', () => {
  beforeEach(resetStorage);

  it('keys written to local, not sync', async () => {
    await setApiKey('sf:GLM-4-9B', 'sk-secret');
    expect(await getApiKey('sf:GLM-4-9B')).toBe('sk-secret');
    // sync 侧不应含 API key
    const syncBlob = JSON.stringify(syncArea._data);
    expect(syncBlob).not.toContain('sk-secret');
  });
});

describe('storage — circuit record round-trip', () => {
  beforeEach(resetStorage);

  it('persists and reads back', async () => {
    const rec = {
      state: 'COOLING' as const,
      cooldownUntil: 99999,
      cooldownMs: 60_000,
      probeWeight: 1.0,
      probeSuccessStreak: 0,
      lastTransitionAt: 1,
    };
    await setCircuit('sf:GLM-4-9B', rec);
    expect(await getCircuit('sf:GLM-4-9B')).toEqual(rec);
  });
});

describe('storage — routing defaults + migration guard', () => {
  beforeEach(resetStorage);

  it('default routing when unset', async () => {
    const s = await getRoutingSettings();
    expect(s.mode).toBe('failover');
    expect(s.preference).toBe(0.5);
    expect(s.concurrency).toBe(1);
  });

  it('set / get round-trip', async () => {
    await setRoutingSettings({ mode: 'smart', preference: 0.8, concurrency: 2, primaryId: 'x' });
    const s = await getRoutingSettings();
    expect(s).toEqual({ mode: 'smart', preference: 0.8, concurrency: 2, primaryId: 'x' });
  });

  it('migration version gate', async () => {
    expect(await isMigrationDone(1)).toBe(false);
    await markMigrationDone(1);
    expect(await isMigrationDone(1)).toBe(true);
    expect(await isMigrationDone(2)).toBe(false);
  });
});
