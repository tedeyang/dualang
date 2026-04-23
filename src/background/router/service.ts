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
} from './storage';
import type {
  ProviderEntry,
  RoutingSettings,
} from '../../shared/router-types';
import { getSettings } from '../settings';

// ============ 核心类型 ============

export interface ResolvedProvider {
  id: string;
  entry: ProviderEntry;
  apiKey: string;
  /** 来自 circuit state —— P5 没熔断时恒为 1.0；P6 评分会乘以这个 */
  probeWeight: number;
  /** 来自路由配置的标签："primary" / "secondary" */
  role: 'primary' | 'secondary' | 'other';
}

export interface RouteContext {
  kind: 'batch' | 'single' | 'super-fine-chunk';
  /** 原文总字符数，供 P6 做分层 tier 评分 */
  originalChars?: number;
  /** 能力需求，比如 batch 调用必须 capability.batch !== 'broken' */
  requires?: { batch?: boolean; streaming?: boolean };
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
 * failover: [primary, secondary]，filter out 禁用 / 无 key / 永久熔断 的条目
 * smart: 当前等价 failover（P6 实装评分）
 */
export async function selectCandidates(
  _ctx: RouteContext = { kind: 'batch' },
): Promise<ResolvedProvider[]> {
  const routing = await getRoutingSettings();
  const providers = await listProviders();
  const byId = new Map(providers.map((p) => [p.id, p]));

  // P5 无论 mode 都是 primary → secondary；smart 改动留给 P6。
  const [primary, secondary] = await Promise.all([
    resolveById(routing.primaryId, byId, 'primary'),
    resolveById(routing.secondaryId, byId, 'secondary'),
  ]);
  const out: ResolvedProvider[] = [];
  if (primary) out.push(primary);
  if (secondary && secondary.id !== primary?.id) out.push(secondary);
  return out;
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
