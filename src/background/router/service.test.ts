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

describe('selectCandidates — smart mode', () => {
  beforeEach(resetStorage);

  it('enumerates all enabled, not just primary/secondary', async () => {
    await storageMod.saveProviders([
      mkEntry('p1', 'https://a/v1', 'Ma'),
      mkEntry('p2', 'https://b/v1', 'Mb'),
      mkEntry('p3', 'https://c/v1', 'Mc'),
    ]);
    await storageMod.setApiKey('p1', 'k1');
    await storageMod.setApiKey('p2', 'k2');
    await storageMod.setApiKey('p3', 'k3');
    await storageMod.setRoutingSettings({
      mode: 'smart', preference: 0.5, concurrency: 1,
      primaryId: 'p1', // should be ignored in smart mode
    });
    const cands = await selectCandidates({ kind: 'batch' });
    expect(cands).toHaveLength(3);
    // 所有都是 untested → 得分相同，排序可能不稳定；只验证全部返回
    expect(cands.map((c) => c.id).sort()).toEqual(['p1', 'p2', 'p3']);
  });

  it('sorts by score descending (fast provider wins)', async () => {
    await storageMod.saveProviders([
      mkEntry('p-slow', 'https://slow/v1', 'M'),
      mkEntry('p-fast', 'https://fast/v1', 'M'),
    ]);
    await storageMod.setApiKey('p-slow', 'k');
    await storageMod.setApiKey('p-fast', 'k');
    await storageMod.setRoutingSettings({
      mode: 'smart', preference: 0, concurrency: 1,  // pref=0 → all weight on speed
    });
    const { createEWMA } = await import('../../shared/ewma');
    await storageMod.setPerformance('p-slow', {
      rttMs: { short: createEWMA(5000), medium: createEWMA(), long: createEWMA() },
      tokensPerSec: createEWMA(),
      successRate: createEWMA(1),
      qualityScore: createEWMA(1),
      lastSampleAt: Date.now(),
    });
    await storageMod.setPerformance('p-fast', {
      rttMs: { short: createEWMA(200), medium: createEWMA(), long: createEWMA() },
      tokensPerSec: createEWMA(),
      successRate: createEWMA(1),
      qualityScore: createEWMA(1),
      lastSampleAt: Date.now(),
    });
    const cands = await selectCandidates({ kind: 'batch', originalChars: 50 });
    expect(cands[0].id).toBe('p-fast');
    expect(cands[1].id).toBe('p-slow');
    expect(cands[0].scoring?.score).toBeGreaterThan(cands[1].scoring!.score);
  });

  it('filters out PERMANENT_DISABLED', async () => {
    await storageMod.saveProviders([
      mkEntry('p1', 'https://a/v1', 'M'),
      mkEntry('p2', 'https://b/v1', 'M'),
    ]);
    await storageMod.setApiKey('p1', 'k1');
    await storageMod.setApiKey('p2', 'k2');
    await storageMod.setCircuit('p1', {
      ...createCircuitRecord(),
      state: 'PERMANENT_DISABLED',
    });
    await storageMod.setRoutingSettings({
      mode: 'smart', preference: 0.5, concurrency: 1,
    });
    const cands = await selectCandidates({ kind: 'batch' });
    expect(cands.map((c) => c.id)).toEqual(['p2']);
  });

  it('filters out batch=broken when ctx.kind=batch', async () => {
    await storageMod.saveProviders([
      mkEntry('p1', 'https://a/v1', 'M'),
      mkEntry('p2', 'https://b/v1', 'M'),
    ]);
    await storageMod.setApiKey('p1', 'k1');
    await storageMod.setApiKey('p2', 'k2');
    await storageMod.setCapability('p1', {
      batch: 'broken', streaming: 'proven', thinkingMode: 'optional', observedAt: 0,
    });
    await storageMod.setRoutingSettings({
      mode: 'smart', preference: 0.5, concurrency: 1,
    });
    const batchOnly = await selectCandidates({ kind: 'batch' });
    expect(batchOnly.map((c) => c.id)).toEqual(['p2']);
    // single 模式下 p1 未被否决
    const single = await selectCandidates({ kind: 'single' });
    expect(single.map((c) => c.id).sort()).toEqual(['p1', 'p2']);
  });

  it('failover skips COOLING primary, falls to secondary', async () => {
    await storageMod.saveProviders([
      mkEntry('p1', 'https://a/v1', 'Ma'),
      mkEntry('p2', 'https://b/v1', 'Mb'),
    ]);
    await storageMod.setApiKey('p1', 'k1');
    await storageMod.setApiKey('p2', 'k2');
    await storageMod.setCircuit('p1', {
      ...createCircuitRecord(),
      state: 'COOLING',
      cooldownUntil: Date.now() + 60_000,
      cooldownMs: 60_000,
    });
    await storageMod.setRoutingSettings({
      mode: 'failover', preference: 0.5, concurrency: 1,
      primaryId: 'p1', secondaryId: 'p2',
    });
    const cands = await selectCandidates({ kind: 'batch' });
    expect(cands.map((c) => c.id)).toEqual(['p2']);
  });

  it('failover lazy-unfreezes primary past cooldown (→ PROBING, picked up again)', async () => {
    await storageMod.saveProviders([mkEntry('p1', 'https://a/v1', 'Ma')]);
    await storageMod.setApiKey('p1', 'k1');
    await storageMod.setCircuit('p1', {
      ...createCircuitRecord(),
      state: 'COOLING',
      cooldownUntil: Date.now() - 1,
      cooldownMs: 60_000,
    });
    await storageMod.setRoutingSettings({
      mode: 'failover', preference: 0.5, concurrency: 1,
      primaryId: 'p1',
    });
    const cands = await selectCandidates({ kind: 'batch' });
    expect(cands.map((c) => c.id)).toEqual(['p1']);
    expect(cands[0].probeWeight).toBeCloseTo(0.1);
    // persisted transition
    const persisted = await storageMod.getCircuit('p1');
    expect(persisted!.state).toBe('PROBING');
  });

  it('PROBING probeWeight shrinks score (still included but demoted)', async () => {
    await storageMod.saveProviders([
      mkEntry('p-probing', 'https://a/v1', 'M'),
      mkEntry('p-healthy', 'https://b/v1', 'M'),
    ]);
    await storageMod.setApiKey('p-probing', 'k1');
    await storageMod.setApiKey('p-healthy', 'k2');
    // Both have identical profile, but p-probing is in PROBING with weight 0.1
    const { createEWMA } = await import('../../shared/ewma');
    const perf = {
      rttMs: { short: createEWMA(500), medium: createEWMA(), long: createEWMA() },
      tokensPerSec: createEWMA(),
      successRate: createEWMA(1),
      qualityScore: createEWMA(1),
      lastSampleAt: Date.now(),
    };
    await storageMod.setPerformance('p-probing', perf);
    await storageMod.setPerformance('p-healthy', perf);
    await storageMod.setCircuit('p-probing', {
      ...createCircuitRecord(),
      state: 'PROBING',
      probeWeight: 0.1,
    });
    await storageMod.setRoutingSettings({
      mode: 'smart', preference: 0.5, concurrency: 1,
    });
    const cands = await selectCandidates({ kind: 'batch' });
    expect(cands[0].id).toBe('p-healthy');
    expect(cands[1].id).toBe('p-probing');
    expect(cands[0].scoring!.score).toBeGreaterThan(cands[1].scoring!.score * 5);
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
