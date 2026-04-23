/**
 * 智能多模型路由器的数据模型。
 * 详细设计见 docs/decisions/smart-router-design.md §2。
 *
 * 存储分层：
 *   chrome.storage.sync   → providers[], routingSettings（小、跨设备同步）
 *   chrome.storage.local  → apiKeys{}, capabilities, profiles, limits, circuit
 *   内存（SW lifecycle）    → liveStateByProvider
 */

import type { EWMA } from './ewma';

// ============ Provider 基本条目 ============

export interface ProviderEntry {
  /** "sf:Qwen/Qwen2.5-7B-Instruct" 形式的稳定主键；删改引用都用它 */
  id: string;
  /** UI 显示名 */
  label: string;
  baseUrl: string;
  model: string;
  /** apiKey 实际存在 chrome.storage.local.dualang_api_keys_v1[id] */
  apiKeyRef: string;
  enabled: boolean;
  /** 共享 TPM 桶的账号归并（同账号不同模型 = 同 group）；评分器会据此避免双路并发打满 */
  accountGroup?: string;
  /** 用户自定义标签："free" / "quality" / "fast" 等 */
  tags?: string[];
  /** 创建时间；用来保留 UI 顺序稳定 */
  createdAt: number;
}

// ============ 能力画像（sampler 或手填）============

export type CapabilityLevel = 'proven' | 'broken' | 'untested';
export type ThinkingMode = 'none' | 'optional' | 'forced';

export interface ProviderCapability {
  /** <tN>...</tN> 批量协议；broken 时走 single 降级 */
  batch: CapabilityLevel;
  streaming: CapabilityLevel;
  /** reasoning token 能否关闭 */
  thinkingMode: ThinkingMode;
  /** 单请求 context 上限（tokens），未知则不填 */
  contextTokens?: number;
  observedAt: number;
}

// ============ 性能画像（EWMA 动态更新）============

export type LatencyTier = 'short' | 'medium' | 'long';

export interface PerformanceProfile {
  rttMs: {
    short: EWMA;
    medium: EWMA;
    long: EWMA;
  };
  tokensPerSec: EWMA;
  /** 质量启发式，[0,1]；由 router.recordOutcome 喂入 */
  qualityScore: EWMA;
  /** 成功率 EWMA，[0,1]；1 表示无错 */
  successRate: EWMA;
  lastSampleAt: number;
}

// ============ Limit 画像（429 学习 + 手填）============

export interface LimitProfile {
  /** 观察到 429 时的 60s 滑窗 tokens 均值 */
  tpmCap?: number;
  rpmCap?: number;
  tpdCap?: number;
  costPerMtoken?: number;
  free: boolean;
  tpmConfidence: 'measured' | 'guessed';
}

// ============ 熔断状态（持久化 —— SW 重启后保留）============

export type CircuitState = 'HEALTHY' | 'COOLING' | 'PROBING' | 'PERMANENT_DISABLED';

export interface CircuitRecord {
  state: CircuitState;
  /** COOLING 期间 > now() 即禁用；懒判断，不依赖 setTimeout */
  cooldownUntil: number;
  /** 当前冷却窗口（ms）；失败一次翻倍，封顶 cooldown_cap_ms */
  cooldownMs: number;
  /** PROBING 态评分权重，0.1 → 1.0 逐步恢复 */
  probeWeight: number;
  probeSuccessStreak: number;
  /** 最近一次错误类型，用于调试显示 */
  lastErrorKind?: string;
  lastTransitionAt: number;
}

export function createCircuitRecord(): CircuitRecord {
  return {
    state: 'HEALTHY',
    cooldownUntil: 0,
    cooldownMs: 0,
    probeWeight: 1.0,
    probeSuccessStreak: 0,
    lastTransitionAt: Date.now(),
  };
}

// ============ LiveState（内存态，SW 重启后从 0 起算）============

export interface LiveState {
  tpmLog: Array<{ t: number; tokens: number }>;
  /** 与 CircuitRecord.cooldownUntil 同步读取，但内存里缓存以减少存储读 */
  cooldownUntil: number;
  /** 最近 60s 内的 429 时间戳，用于 stabilityScore */
  recent429s: number[];
  inflightCount: number;
}

export function createLiveState(): LiveState {
  return {
    tpmLog: [],
    cooldownUntil: 0,
    recent429s: [],
    inflightCount: 0,
  };
}

// ============ 路由设置（UI 可改）============

export type RoutingMode = 'failover' | 'smart';

export interface RoutingSettings {
  mode: RoutingMode;
  /** [0,1]：0 = 最快（偏 speed），1 = 最好（偏 quality） */
  preference: number;
  /** 智能模式下并发 slot 数（hedged request）；默认 1 */
  concurrency: number;
  /** 主从模式下的主/备 id（failover 模式专用） */
  primaryId?: string;
  secondaryId?: string;
}

export function defaultRoutingSettings(): RoutingSettings {
  return {
    mode: 'failover',
    preference: 0.5,
    concurrency: 1,
  };
}

// ============ 存储 key 常量 ============

export const STORAGE_KEYS = {
  providers: 'dualang_providers_v1',
  routing: 'dualang_routing_v1',
  apiKeys: 'dualang_api_keys_v1',
  capabilities: 'dualang_capabilities_v1',
  performance: 'dualang_perf_v1',
  limits: 'dualang_limits_v1',
  circuit: 'dualang_circuit_v1',
  migrationDone: 'dualang_router_migration_v1',
} as const;
