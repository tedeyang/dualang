import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  computeMigration,
  providerSlugFromBaseUrl,
  makeProviderId,
} from './migration';
import { defaultRoutingSettings } from '../../shared/router-types';

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

const { runMigration } = await import('./migration');
const storageMod = await import('./storage');

function resetStorage() {
  for (const k of Object.keys(syncArea._data)) delete syncArea._data[k];
  for (const k of Object.keys(localArea._data)) delete localArea._data[k];
  storageMod.__clearCacheForTest();
}

describe('providerSlugFromBaseUrl', () => {
  it('maps known hosts', () => {
    expect(providerSlugFromBaseUrl('https://api.siliconflow.cn/v1')).toBe('sf');
    expect(providerSlugFromBaseUrl('https://api.moonshot.cn/v1')).toBe('moonshot');
    expect(providerSlugFromBaseUrl('https://api.deepseek.com/v1')).toBe('deepseek');
    expect(providerSlugFromBaseUrl('https://api.openai.com/v1')).toBe('openai');
  });

  it('falls back to normalized host', () => {
    expect(providerSlugFromBaseUrl('https://api.custom-llm.io/v1')).toBe('custom-llm-io');
  });

  it('tolerates bad url', () => {
    expect(providerSlugFromBaseUrl('garbage')).toBe('custom');
  });
});

describe('makeProviderId', () => {
  it('combines slug + model', () => {
    expect(makeProviderId('https://api.siliconflow.cn/v1', 'THUDM/GLM-4-9B-0414'))
      .toBe('sf:THUDM/GLM-4-9B-0414');
  });
});

describe('computeMigration', () => {
  const NOW = 1_700_000_000_000;
  const empty = () => [];

  it('maps primary-only legacy settings', () => {
    const { toWrite, apiKeys, routing } = computeMigration(
      {
        apiKey: 'sk-sf',
        baseUrl: 'https://api.siliconflow.cn/v1',
        model: 'THUDM/GLM-4-9B-0414',
      },
      {},
      empty(),
      defaultRoutingSettings(),
      NOW,
    );
    expect(toWrite).toHaveLength(1);
    expect(toWrite[0].id).toBe('sf:THUDM/GLM-4-9B-0414');
    expect(toWrite[0].accountGroup).toBe('sf');
    expect(apiKeys['sf:THUDM/GLM-4-9B-0414']).toBe('sk-sf');
    expect(routing.primaryId).toBe('sf:THUDM/GLM-4-9B-0414');
    expect(routing.secondaryId).toBeUndefined();
  });

  it('adds fallback as second entry when different from primary', () => {
    const { toWrite, apiKeys, routing } = computeMigration(
      {
        apiKey: 'sk-sf',
        baseUrl: 'https://api.siliconflow.cn/v1',
        model: 'THUDM/GLM-4-9B-0414',
        fallbackEnabled: true,
        fallbackApiKey: 'sk-ms',
        fallbackBaseUrl: 'https://api.moonshot.cn/v1',
        fallbackModel: 'moonshot-v1-8k',
      },
      {},
      empty(),
      defaultRoutingSettings(),
      NOW,
    );
    expect(toWrite).toHaveLength(2);
    expect(routing.primaryId).toBe('sf:THUDM/GLM-4-9B-0414');
    expect(routing.secondaryId).toBe('moonshot:moonshot-v1-8k');
    expect(apiKeys['moonshot:moonshot-v1-8k']).toBe('sk-ms');
  });

  it('dedupes fallback == primary', () => {
    const { toWrite } = computeMigration(
      {
        apiKey: 'sk',
        baseUrl: 'https://api.siliconflow.cn/v1',
        model: 'THUDM/GLM-4-9B-0414',
        fallbackEnabled: true,
        fallbackApiKey: 'sk',
        fallbackBaseUrl: 'https://api.siliconflow.cn/v1',
        fallbackModel: 'THUDM/GLM-4-9B-0414',
      },
      {},
      empty(),
      defaultRoutingSettings(),
      NOW,
    );
    expect(toWrite).toHaveLength(1);
  });

  it('adds Moonshot entry from config.json when absent', () => {
    const { toWrite, apiKeys } = computeMigration(
      {
        apiKey: 'sk-sf',
        baseUrl: 'https://api.siliconflow.cn/v1',
        model: 'THUDM/GLM-4-9B-0414',
      },
      { providers: { moonshot: { apiKey: 'sk-ms-cfg' } } },
      empty(),
      defaultRoutingSettings(),
      NOW,
    );
    expect(toWrite.map((p) => p.id)).toContain('moonshot:moonshot-v1-8k');
    expect(apiKeys['moonshot:moonshot-v1-8k']).toBe('sk-ms-cfg');
  });

  it('is idempotent against existing list (no duplicates)', () => {
    const existing = [
      {
        id: 'sf:THUDM/GLM-4-9B-0414',
        label: 'x',
        baseUrl: 'https://api.siliconflow.cn/v1',
        model: 'THUDM/GLM-4-9B-0414',
        apiKeyRef: 'sf:THUDM/GLM-4-9B-0414',
        enabled: true,
        createdAt: 1,
      },
    ];
    const { toWrite } = computeMigration(
      {
        apiKey: 'sk',
        baseUrl: 'https://api.siliconflow.cn/v1',
        model: 'THUDM/GLM-4-9B-0414',
      },
      {},
      existing,
      defaultRoutingSettings(),
      NOW,
    );
    expect(toWrite).toHaveLength(1);
    // 保留已有条目（label 不被覆盖）
    expect(toWrite[0].label).toBe('x');
  });

  it('does not overwrite existing routing primaryId', () => {
    const { routing } = computeMigration(
      {
        apiKey: 'sk',
        baseUrl: 'https://api.siliconflow.cn/v1',
        model: 'M',
      },
      {},
      [],
      { ...defaultRoutingSettings(), primaryId: 'preset-id' },
      NOW,
    );
    expect(routing.primaryId).toBe('preset-id');
  });

  it('no legacy baseUrl → only Moonshot from config', () => {
    const { toWrite } = computeMigration(
      {},
      { providers: { moonshot: { apiKey: 'sk-ms' } } },
      [],
      defaultRoutingSettings(),
      NOW,
    );
    expect(toWrite).toHaveLength(1);
    expect(toWrite[0].baseUrl).toContain('moonshot');
  });
});

describe('runMigration — apiKey backfill', () => {
  beforeEach(resetStorage);

  it('first run creates providers and writes keys', async () => {
    await runMigration(
      {
        apiKey: 'sk-sf',
        baseUrl: 'https://api.siliconflow.cn/v1',
        model: 'THUDM/GLM-4-9B-0414',
      },
      { providers: { moonshot: { apiKey: 'sk-ms' } } },
    );
    const providers = await storageMod.listProviders();
    expect(providers.length).toBeGreaterThanOrEqual(2);
    expect(await storageMod.getApiKey('sf:THUDM/GLM-4-9B-0414')).toBe('sk-sf');
    expect(await storageMod.getApiKey('moonshot:moonshot-v1-8k')).toBe('sk-ms');
  });

  it('version marker set after first run', async () => {
    await runMigration(
      { apiKey: 'sk-sf', baseUrl: 'https://api.siliconflow.cn/v1', model: 'M' },
      {},
    );
    expect(await storageMod.isMigrationDone(1)).toBe(true);
  });

  it('backfills missing key on subsequent run (first run ran before key existed)', async () => {
    // Simulate: first run with no legacy apiKey → providers created, no keys stored
    await runMigration(
      { apiKey: '', baseUrl: 'https://api.siliconflow.cn/v1', model: 'THUDM/GLM-4-9B-0414' },
      {},
    );
    expect(await storageMod.getApiKey('sf:THUDM/GLM-4-9B-0414')).toBe('');

    // Second run with proper key (user saved later) → should fill in the blank
    await runMigration(
      { apiKey: 'sk-sf-late', baseUrl: 'https://api.siliconflow.cn/v1', model: 'THUDM/GLM-4-9B-0414' },
      {},
    );
    expect(await storageMod.getApiKey('sf:THUDM/GLM-4-9B-0414')).toBe('sk-sf-late');
  });

  it('does NOT overwrite an already-stored key', async () => {
    await runMigration(
      { apiKey: 'sk-original', baseUrl: 'https://api.siliconflow.cn/v1', model: 'M' },
      {},
    );
    expect(await storageMod.getApiKey('sf:M')).toBe('sk-original');

    // User changed the key via Providers UI; subsequent migration must not overwrite
    await storageMod.setApiKey('sf:M', 'sk-user-custom');
    await runMigration(
      { apiKey: 'sk-original', baseUrl: 'https://api.siliconflow.cn/v1', model: 'M' },
      {},
    );
    expect(await storageMod.getApiKey('sf:M')).toBe('sk-user-custom');
  });

  it('does NOT re-add user-deleted providers (providers write is guarded by marker)', async () => {
    await runMigration(
      {
        apiKey: 'sk', baseUrl: 'https://api.siliconflow.cn/v1', model: 'M',
        fallbackEnabled: true, fallbackApiKey: 'sk2',
        fallbackBaseUrl: 'https://api.moonshot.cn/v1', fallbackModel: 'moonshot-v1-8k',
      },
      {},
    );
    expect((await storageMod.listProviders()).length).toBe(2);

    // User deletes fallback
    await storageMod.deleteProvider('moonshot:moonshot-v1-8k');
    expect((await storageMod.listProviders()).length).toBe(1);

    // Second migration with same inputs → must not re-add
    await runMigration(
      {
        apiKey: 'sk', baseUrl: 'https://api.siliconflow.cn/v1', model: 'M',
        fallbackEnabled: true, fallbackApiKey: 'sk2',
        fallbackBaseUrl: 'https://api.moonshot.cn/v1', fallbackModel: 'moonshot-v1-8k',
      },
      {},
    );
    expect((await storageMod.listProviders()).length).toBe(1);
  });
});
