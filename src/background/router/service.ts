/**
 * 路由器服务（P5）：
 * 把"该用哪个 provider"的决策从 handleTranslateBatch 里的散落分支
 * 统一到一个服务对象里。当前等价于主从模式（failover）；P6 再接 smart 评分。
 *
 * 两种对外面：
 *   - resolveSettings(base) 把 provider 数据注入 Settings（apiKey/baseUrl/model +
 *     fallbackApiKey/fallbackBaseUrl/fallbackModel）。handleTranslateBatch 在
 *     入口调用这个函数，下游所有 api.ts / pipeline.ts 就不用再感知 router。
 *   - select(ctx) 返回一个有序候选列表，P6 扩 smart 评分时替换这个实现。
 *
 * 失败路径：如果 router 没配好（空 providers、primary 没 key 等），直接返回 base。
 * 用户相当于还在"P2 以前"的旧 settings 路径上 —— 行为完全不变。
 */

import type { Settings } from '../../shared/types';
import {
  listProviders,
  getApiKey,
  getRoutingSettings,
  getCircuit,
  getPerformance,
  getLimits,
  getCapability,
} from './storage';
import type {
  ProviderEntry,
  RoutingSettings,
} from '../../shared/router-types';
import { getSettings } from '../settings';
import { tierOf } from './recorder';
import { scoreSlot, vetoSlot, type ScoreBreakdown } from './scoring';

// ============ 核心类型 ============

export interface ResolvedProvider {
  id: string;
  entry: ProviderEntry;
  apiKey: string;
  /** 来自 circuit state —— HEALTHY 为 1.0；PROBING 态 < 1 —— 评分已乘过 */
  probeWeight: number;
  /** 来自路由配置的标签："primary" / "secondary"；smart 模式下按分数排序标 "other" */
  role: 'primary' | 'secondary' | 'other';
  /** smart 模式下的评分详情；failover 模式不填 */
  scoring?: ScoreBreakdown;
}

export interface RouteContext {
  kind: 'batch' | 'single' | 'super-fine-chunk';
  /** 原文总字符数，供 P6 做分层 tier 评分 + context overflow veto */
  originalChars?: number;
  /** 能力需求，比如 batch 调用必须 capability.batch !== 'broken' */
  requires?: { batch?: boolean; streaming?: boolean };
  /** 用户在"高级"里关了 thinking —— 强制思考的模型被 veto */
  thinkingDisabledByUser?: boolean;
}

// ============ 候选解析 ============

async function resolveById(
  id: string | undefined,
  byId: Map<string, ProviderEntry>,
  role: ResolvedProvider['role'],
): Promise<ResolvedProvider | null> {
  if (!id) return null;
  const entry = byId.get(id);
  if (!entry || !entry.enabled) return null;
  const apiKey = await getApiKey(id);
  if (!apiKey) return null;
  const circuit = await getCircuit(id);
  if (circuit?.state === 'PERMANENT_DISABLED') return null;
  return { id, entry, apiKey, probeWeight: circuit?.probeWeight ?? 1, role };
}

/**
 * 按 routing 配置返回有序候选。
 *   failover: [primary, secondary]，filter 掉禁用 / 无 key / 永久熔断
 *   smart:    枚举所有 enabled providers → vetoSlot 硬过滤 → scoreSlot 加权 → 分数降序
 */
export async function selectCandidates(
  ctx: RouteContext = { kind: 'batch' },
): Promise<ResolvedProvider[]> {
  const routing = await getRoutingSettings();
  if (routing.mode === 'smart') {
    return selectSmart(ctx, routing);
  }
  return selectFailover(routing);
}

async function selectFailover(routing: RoutingSettings): Promise<ResolvedProvider[]> {
  const providers = await listProviders();
  const byId = new Map(providers.map((p) => [p.id, p]));
  const [primary, secondary] = await Promise.all([
    resolveById(routing.primaryId, byId, 'primary'),
    resolveById(routing.secondaryId, byId, 'secondary'),
  ]);
  const out: ResolvedProvider[] = [];
  if (primary) out.push(primary);
  if (secondary && secondary.id !== primary?.id) out.push(secondary);
  return out;
}

async function selectSmart(ctx: RouteContext, routing: RoutingSettings): Promise<ResolvedProvider[]> {
  const providers = await listProviders();
  const enabled = providers.filter((p) => p.enabled);
  if (!enabled.length) return [];

  // 并发加载每条 provider 的画像 + 熔断 + capability + apiKey
  const loaded = await Promise.all(
    enabled.map(async (p) => {
      const [apiKey, profile, limits, circuit, capability] = await Promise.all([
        getApiKey(p.id),
        getPerformance(p.id),
        getLimits(p.id),
        getCircuit(p.id),
        getCapability(p.id),
      ]);
      return { p, apiKey, snap: { profile, limits, circuit, capability } };
    }),
  );

  // 无 apiKey 直接丢（不算 veto，只是不可用）
  const withKey = loaded.filter((x) => x.apiKey);

  const now = Date.now();
  const vetoCtx = {
    kind: ctx.kind,
    originalChars: ctx.originalChars,
    thinkingDisabledByUser: ctx.thinkingDisabledByUser,
  };
  const surviving = withKey.filter((x) => !vetoSlot(x.snap, vetoCtx, now).vetoed);

  const tier = tierOf(ctx.originalChars ?? 0);
  const scoreCtx = { tier, pref: routing.preference, originalChars: ctx.originalChars };
  const scored = surviving.map((x) => ({
    ...x,
    breakdown: scoreSlot(x.snap, scoreCtx),
  }));
  scored.sort((a, b) => b.breakdown.score - a.breakdown.score);

  return scored.map((x) => ({
    id: x.p.id,
    entry: x.p,
    apiKey: x.apiKey,
    probeWeight: x.breakdown.probeWeight,
    role: 'other' as const,
    scoring: x.breakdown,
  }));
}

// ============ Settings 注入 ============

/** 纯函数：给定 base + 候选，返回注入后的 Settings。便于单测。*/
export function mergeSettingsWithCandidates(
  base: Settings,
  candidates: ResolvedProvider[],
): Settings {
  const primary = candidates[0];
  if (!primary) return base;
  const secondary = candidates[1];
  return {
    ...base,
    apiKey: primary.apiKey,
    baseUrl: primary.entry.baseUrl,
    model: primary.entry.model,
    ...(secondary
      ? {
          fallbackEnabled: true,
          fallbackApiKey: secondary.apiKey,
          fallbackBaseUrl: secondary.entry.baseUrl,
          fallbackModel: secondary.entry.model,
        }
      : {}),
  };
}

/** 便捷：读 router + 把候选注入到传入的 base settings 上 */
export async function resolveSettings(
  base: Settings,
  ctx: RouteContext = { kind: 'batch' },
): Promise<Settings> {
  const candidates = await selectCandidates(ctx);
  return mergeSettingsWithCandidates(base, candidates);
}

/** 便捷：getSettings() + resolveSettings —— handleTranslateBatch 入口一行接替 */
export async function getEffectiveSettings(ctx?: RouteContext): Promise<Settings> {
  const base = await getSettings();
  return resolveSettings(base, ctx);
}
