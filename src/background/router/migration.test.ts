import { describe, it, expect } from 'vitest';
import {
  computeMigration,
  providerSlugFromBaseUrl,
  makeProviderId,
} from './migration';
import { defaultRoutingSettings } from '../../shared/router-types';

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
