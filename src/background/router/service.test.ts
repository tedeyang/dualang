import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mergeSettingsWithCandidates, type ResolvedProvider } from './service';
import { createCircuitRecord } from '../../shared/router-types';

function mkCandidate(partial: Partial<ResolvedProvider> = {}): ResolvedProvider {
  return {
    id: 'sf:M',
    entry: {
      id: 'sf:M',
      label: 'Test',
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'THUDM/GLM-4-9B-0414',
      apiKeyRef: 'sf:M',
      enabled: true,
      createdAt: 0,
    },
    apiKey: 'sk-primary',
    probeWeight: 1,
    role: 'primary',
    ...partial,
  };
}

describe('mergeSettingsWithCandidates', () => {
  it('empty candidates → base unchanged', () => {
    const base = { apiKey: 'legacy', baseUrl: 'https://legacy', model: 'legacy' };
    expect(mergeSettingsWithCandidates(base, [])).toEqual(base);
  });

  it('single primary overrides main fields', () => {
    const base = { apiKey: 'legacy', baseUrl: 'https://legacy', model: 'legacy' };
    const merged = mergeSettingsWithCandidates(base, [mkCandidate()]);
    expect(merged.apiKey).toBe('sk-primary');
    expect(merged.baseUrl).toBe('https://api.siliconflow.cn/v1');
    expect(merged.model).toBe('THUDM/GLM-4-9B-0414');
    expect(merged.fallbackEnabled).toBeUndefined();
  });

  it('secondary populates fallback fields and enables', () => {
    const base = { apiKey: 'legacy' };
    const sec = mkCandidate({
      id: 'moonshot:v1',
      apiKey: 'sk-sec',
      role: 'secondary',
      entry: {
        id: 'moonshot:v1',
        label: 'Moonshot',
        baseUrl: 'https://api.moonshot.cn/v1',
        model: 'moonshot-v1-8k',
        apiKeyRef: 'moonshot:v1',
        enabled: true,
        createdAt: 0,
      },
    });
    const merged = mergeSettingsWithCandidates(base, [mkCandidate(), sec]);
    expect(merged.apiKey).toBe('sk-primary');
    expect(merged.fallbackEnabled).toBe(true);
    expect(merged.fallbackApiKey).toBe('sk-sec');
    expect(merged.fallbackBaseUrl).toBe('https://api.moonshot.cn/v1');
    expect(merged.fallbackModel).toBe('moonshot-v1-8k');
  });

  it('preserves non-provider Settings fields', () => {
    const base = {
      apiKey: 'legacy', targetLang: 'zh-TW', maxTokens: 2048,
      enableStreaming: true, lineFusionEnabled: true,
    };
    const merged = mergeSettingsWithCandidates(base, [mkCandidate()]);
    expect(merged.targetLang).toBe('zh-TW');
    expect(merged.maxTokens).toBe(2048);
    expect(merged.enableStreaming).toBe(true);
    expect(merged.lineFusionEnabled).toBe(true);
  });
});

// ============ Full-flow integration with mocked storage ============

function makeStorageArea() {
  const data: Record<string, any> = {};
  return {
    _data: data,
    get: vi.fn((keys?: any) => {
      if (keys == null) return Promise.resolve({ ...data });
      if (typeof keys === 'string') return Promise.resolve({ [keys]: data[keys] });
      if (Array.isArray(keys)) {
        const out: Record<string, any> = {};
        for (const k of keys) out[k] = data[k];
        return Promise.resolve(out);
      }
      const out: Record<string, any> = {};
      for (const [k, def] of Object.entries(keys)) out[k] = k in data ? data[k] : def;
      return Promise.resolve(out);
    }),
    set: vi.fn((obj: Record<string, any>) => {
      Object.assign(data, obj);
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
  runtime: { getURL: (p: string) => `chrome-extension://x/${p}` },
};

// 禁用 settings.ts 的 fetch（它会尝试加载 config.json）
(globalThis as any).fetch = vi.fn().mockResolvedValue({
  ok: false, text: async () => '', json: async () => ({}),
});

const storageMod = await import('./storage');
const { selectCandidates, resolveSettings } = await import('./service');

function resetStorage() {
  for (const k of Object.keys(syncArea._data)) delete syncArea._data[k];
  for (const k of Object.keys(localArea._data)) delete localArea._data[k];
  storageMod.__clearCacheForTest();
}

const mkEntry = (id: string, baseUrl: string, model: string, enabled = true) => ({
  id, label: id, baseUrl, model, apiKeyRef: id, enabled, createdAt: 0,
});

describe('selectCandidates', () => {
  beforeEach(resetStorage);

  it('returns empty when no providers', async () => {
    expect(await selectCandidates()).toEqual([]);
  });

  it('returns [primary] when only primary configured', async () => {
    await storageMod.saveProviders([mkEntry('p1', 'https://a/v1', 'M')]);
    await storageMod.setApiKey('p1', 'sk-a');
    await storageMod.setRoutingSettings({
      mode: 'failover', preference: 0.5, concurrency: 1, primaryId: 'p1',
    });
    const cands = await selectCandidates();
    expect(cands.map((c) => c.id)).toEqual(['p1']);
  });

  it('skips primary if enabled=false', async () => {
    await storageMod.saveProviders([
      mkEntry('p1', 'https://a/v1', 'M', false),
      mkEntry('p2', 'https://b/v1', 'M'),
    ]);
    await storageMod.setApiKey('p1', 'sk-a');
    await storageMod.setApiKey('p2', 'sk-b');
    await storageMod.setRoutingSettings({
      mode: 'failover', preference: 0.5, concurrency: 1,
      primaryId: 'p1', secondaryId: 'p2',
    });
    const cands = await selectCandidates();
    expect(cands.map((c) => c.id)).toEqual(['p2']);
  });

  it('skips provider with missing apiKey', async () => {
    await storageMod.saveProviders([
      mkEntry('p1', 'https://a/v1', 'M'),
      mkEntry('p2', 'https://b/v1', 'M'),
    ]);
    // only p2 has key
    await storageMod.setApiKey('p2', 'sk-b');
    await storageMod.setRoutingSettings({
      mode: 'failover', preference: 0.5, concurrency: 1,
      primaryId: 'p1', secondaryId: 'p2',
    });
    const cands = await selectCandidates();
    expect(cands.map((c) => c.id)).toEqual(['p2']);
  });

  it('skips PERMANENT_DISABLED circuit', async () => {
    await storageMod.saveProviders([
      mkEntry('p1', 'https://a/v1', 'M'),
      mkEntry('p2', 'https://b/v1', 'M'),
    ]);
    await storageMod.setApiKey('p1', 'sk-a');
    await storageMod.setApiKey('p2', 'sk-b');
    await storageMod.setRoutingSettings({
      mode: 'failover', preference: 0.5, concurrency: 1,
      primaryId: 'p1', secondaryId: 'p2',
    });
    await storageMod.setCircuit('p1', {
      ...createCircuitRecord(),
      state: 'PERMANENT_DISABLED',
    });
    const cands = await selectCandidates();
    expect(cands.map((c) => c.id)).toEqual(['p2']);
  });

  it('dedupes primary=secondary', async () => {
    await storageMod.saveProviders([mkEntry('p1', 'https://a/v1', 'M')]);
    await storageMod.setApiKey('p1', 'sk-a');
    await storageMod.setRoutingSettings({
      mode: 'failover', preference: 0.5, concurrency: 1,
      primaryId: 'p1', secondaryId: 'p1',
    });
    const cands = await selectCandidates();
    expect(cands).toHaveLength(1);
  });
});

describe('resolveSettings', () => {
  beforeEach(resetStorage);

  it('preserves base when router has no primary', async () => {
    const base = { apiKey: 'legacy', baseUrl: 'https://legacy', model: 'legacy' };
    expect(await resolveSettings(base)).toEqual(base);
  });

  it('injects router provider on top of base', async () => {
    await storageMod.saveProviders([
      mkEntry('p1', 'https://a/v1', 'Ma'),
      mkEntry('p2', 'https://b/v1', 'Mb'),
    ]);
    await storageMod.setApiKey('p1', 'sk-a');
    await storageMod.setApiKey('p2', 'sk-b');
    await storageMod.setRoutingSettings({
      mode: 'failover', preference: 0.5, concurrency: 1,
      primaryId: 'p1', secondaryId: 'p2',
    });
    const merged = await resolveSettings({ apiKey: 'legacy', targetLang: 'zh-CN' });
    expect(merged.apiKey).toBe('sk-a');
    expect(merged.baseUrl).toBe('https://a/v1');
    expect(merged.model).toBe('Ma');
    expect(merged.fallbackApiKey).toBe('sk-b');
    expect(merged.fallbackModel).toBe('Mb');
    expect(merged.fallbackEnabled).toBe(true);
    expect(merged.targetLang).toBe('zh-CN');
  });
});
