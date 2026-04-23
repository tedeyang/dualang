/**
 * 旧 settings + config.json → providers[] 的一次性迁移。
 *
 * 幂等：通过 migrationDone 版本号控制；同版本重复调用 no-op。
 * 不删除旧 sync 字段：保证老代码路径（getSettings）在过渡期继续工作；
 * 等路由器完全接管后再做 v2 migration 清理。
 */

import { defaultRoutingSettings, type ProviderEntry, type RoutingSettings } from '../../shared/router-types';
import {
  listProviders,
  saveProviders,
  setApiKey,
  getApiKey,
  setRoutingSettings,
  isMigrationDone,
  markMigrationDone,
  getRoutingSettings,
} from './storage';

export const ROUTER_MIGRATION_VERSION = 1;

/** 从 baseUrl 推导 slug，用于 provider id 前缀 */
export function providerSlugFromBaseUrl(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    const host = u.hostname;
    if (host.includes('siliconflow')) return 'sf';
    if (host.includes('moonshot')) return 'moonshot';
    if (host.includes('deepseek')) return 'deepseek';
    if (host.includes('openai')) return 'openai';
    if (host.includes('anthropic')) return 'anthropic';
    return host.replace(/^api\./, '').replace(/\./g, '-');
  } catch {
    return 'custom';
  }
}

export function makeProviderId(baseUrl: string, model: string): string {
  return `${providerSlugFromBaseUrl(baseUrl)}:${model}`;
}

function makeLabel(baseUrl: string, model: string): string {
  const slug = providerSlugFromBaseUrl(baseUrl);
  const shortModel = model.includes('/') ? model.split('/').pop() : model;
  const providerName: Record<string, string> = {
    sf: 'SiliconFlow',
    moonshot: 'Moonshot',
    deepseek: 'DeepSeek',
    openai: 'OpenAI',
    anthropic: 'Anthropic',
  };
  const name = providerName[slug] || slug;
  return `${shortModel} · ${name}`;
}

export interface LegacySettingsSnapshot {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fallbackEnabled?: boolean;
  fallbackApiKey?: string;
  fallbackBaseUrl?: string;
  fallbackModel?: string;
}

export interface ConfigJsonSnapshot {
  providers?: Record<string, { apiKey?: string }>;
}

export interface MigrationResult {
  inserted: ProviderEntry[];
  skipped: ProviderEntry[]; // 已存在（由 id 判定）的不覆盖
  routing: RoutingSettings;
}

/** 纯函数：基于快照产出要写入的 providers + routing。不访问存储，便于测试。 */
export function computeMigration(
  legacy: LegacySettingsSnapshot,
  cfg: ConfigJsonSnapshot,
  existing: ProviderEntry[],
  existingRouting: RoutingSettings,
  now: number = Date.now(),
): { toWrite: ProviderEntry[]; apiKeys: Record<string, string>; routing: RoutingSettings } {
  const byId = new Map<string, ProviderEntry>(existing.map((p) => [p.id, p]));
  const apiKeys: Record<string, string> = {};
  const ensure = (
    baseUrl: string | undefined,
    model: string | undefined,
    apiKey: string | undefined,
    tags: string[],
  ): string | null => {
    if (!baseUrl || !model) return null;
    const id = makeProviderId(baseUrl, model);
    if (!byId.has(id)) {
      const entry: ProviderEntry = {
        id,
        label: makeLabel(baseUrl, model),
        baseUrl,
        model,
        apiKeyRef: id,
        enabled: true,
        accountGroup: providerSlugFromBaseUrl(baseUrl),
        tags: tags.slice(),
        createdAt: now,
      };
      byId.set(id, entry);
    }
    if (apiKey) apiKeys[id] = apiKey;
    return id;
  };

  const primaryId = ensure(legacy.baseUrl, legacy.model, legacy.apiKey, ['primary']);

  let secondaryId: string | null = null;
  if (
    legacy.fallbackBaseUrl &&
    legacy.fallbackModel &&
    // 与 primary 不是同一条
    makeProviderId(legacy.fallbackBaseUrl, legacy.fallbackModel) !== primaryId
  ) {
    secondaryId = ensure(
      legacy.fallbackBaseUrl,
      legacy.fallbackModel,
      legacy.fallbackApiKey,
      ['fallback'],
    );
  }

  // config.json 里的 moonshot key —— 若当前没有 moonshot entry，补一条默认 moonshot-v1-8k
  const moonshotKey = cfg.providers?.moonshot?.apiKey;
  if (moonshotKey) {
    const hasMoonshot = Array.from(byId.values()).some(
      (p) => p.baseUrl.includes('moonshot'),
    );
    if (!hasMoonshot) {
      ensure('https://api.moonshot.cn/v1', 'moonshot-v1-8k', moonshotKey, ['long-article']);
    } else {
      // 若已有但缺 key（legacy 的 sync 没存），补写 key 到第一条 moonshot
      for (const p of byId.values()) {
        if (p.baseUrl.includes('moonshot') && !apiKeys[p.id]) {
          apiKeys[p.id] = moonshotKey;
          break;
        }
      }
    }
  }

  const routing: RoutingSettings = {
    ...existingRouting,
    mode: existingRouting.mode ?? 'failover',
    primaryId: existingRouting.primaryId || primaryId || undefined,
    secondaryId: existingRouting.secondaryId || secondaryId || undefined,
  };

  return { toWrite: Array.from(byId.values()), apiKeys, routing };
}

/**
 * 运行迁移。两段式：
 *   A) 首次：建 providers 列表 + 写 routing + 打版本戳（只跑一次）
 *   B) 每次：对 sync 里有但 apiKeys map 里没的 provider，从 legacy/cfg 反查并补 key。
 *      这条是必须的 —— 首次运行时若 legacy.apiKey 尚空（SW 抢先于用户保存前触发），
 *      A 段落标志位会锁住，不补 B 就无法再从 legacy 带出 key。
 */
export async function runMigration(
  legacy: LegacySettingsSnapshot,
  cfg: ConfigJsonSnapshot,
): Promise<MigrationResult> {
  const migrationAlreadyDone = await isMigrationDone(ROUTER_MIGRATION_VERSION);
  const existing = await listProviders();
  const existingRouting = await getRoutingSettings();
  const existingIds = new Set(existing.map((p) => p.id));
  const { toWrite, apiKeys, routing } = computeMigration(legacy, cfg, existing, existingRouting);

  // A) 首次建 providers + routing + 标志位
  if (!migrationAlreadyDone) {
    await saveProviders(toWrite);
    await setRoutingSettings(routing);
    await markMigrationDone(ROUTER_MIGRATION_VERSION);
  }

  // B) 每次：对"现存 providers 但还没 apiKey" 的，从 apiKeys map 里补
  const currentProviders = await listProviders();
  const missing: Array<[string, string]> = [];
  for (const p of currentProviders) {
    const derived = apiKeys[p.id];
    if (!derived) continue;
    const stored = await getApiKey(p.id);
    if (!stored) missing.push([p.id, derived]);
  }
  await Promise.all(missing.map(([id, k]) => setApiKey(id, k)));

  const inserted = migrationAlreadyDone
    ? []
    : toWrite.filter((p) => !existingIds.has(p.id));
  const skipped = toWrite.filter((p) => existingIds.has(p.id));
  return { inserted, skipped, routing };
}
