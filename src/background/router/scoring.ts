/**
 * 智能路由评分（P6）。对应设计 §4.2 + §4.3 + §4.4。
 *
 * 全部分量归一化到 [0,1]；权重和恒为 1；组合分 ∈ [0,1]。
 * 不做 I/O；输入是 slot 的快照（profile + limit + circuit + capability + liveTpm）。
 */

import type {
  PerformanceProfile,
  LimitProfile,
  CircuitRecord,
  ProviderCapability,
  RoutingSettings,
  LatencyTier,
} from '../../shared/router-types';
import { readEWMA } from '../../shared/ewma';

// ============ 参数（设计 §4.3 权重初始值）============

export const TUNING = {
  // speedScore 对数刻度端点
  rttLowMs: 100,        // 100ms 对应 speedScore = 1
  rttHighMs: 10_000,    // 10s 对应 speedScore = 0
  // load headroom
  tpmCapDefault: 50_000,
  // stability：最近 429 饱和阈值
  recent429Saturate: 5,
  // 未测 provider 的中性默认
  untestedSpeedScore: 0.5,
  untestedQualityScore: 0.5,
} as const;

// ============ 分量 ============

/**
 * speedScore ∈ [0,1]
 *   100ms → 1.0
 *   10s   → 0.0
 *   1s    → ~0.5
 * 对数刻度：比线性 1/rtt 在极端值上更稳。
 * 无样本 → 返回中性值 0.5；由上层决定是否打 "未测" 标记。
 */
export function speedScore(rttMs: number | null | undefined): number {
  if (rttMs == null || !Number.isFinite(rttMs) || rttMs <= 0) return TUNING.untestedSpeedScore;
  const clamped = Math.min(Math.max(rttMs, TUNING.rttLowMs), TUNING.rttHighMs);
  // log(rttHigh/clamped) / log(rttHigh/rttLow)
  const num = Math.log(TUNING.rttHighMs / clamped);
  const den = Math.log(TUNING.rttHighMs / TUNING.rttLowMs);
  const s = num / den;
  return Math.min(Math.max(s, 0), 1);
}

export function qualityScore(profile: PerformanceProfile | undefined): number {
  if (!profile) return TUNING.untestedQualityScore;
  const raw = readEWMA(profile.qualityScore, TUNING.untestedQualityScore);
  return Math.min(Math.max(raw, 0), 1);
}

/**
 * loadHeadroom = clamp(1 − tokensInWindow / tpmCap, 0, 1)
 * 无 tpmCap 数据 → 默认 50K
 * 无 tpm 观测 → tokensInWindow=0 → headroom=1
 */
export function loadHeadroom(tokensInWindow: number, limits: LimitProfile | undefined): number {
  const cap = limits?.tpmCap || TUNING.tpmCapDefault;
  if (cap <= 0) return 1;
  const used = Math.max(0, tokensInWindow);
  return Math.min(Math.max(1 - used / cap, 0), 1);
}

/**
 * stabilityScore = successRateEWMA × (1 − min(1, recent429 / saturate))
 * 近 60s 内 0 次 429 → 满乘；≥ saturate 次 → 归零。
 * 无 profile → 中性 0.5（成功率未知）× 1（无 429 记录）= 0.5
 */
export function stabilityScore(
  profile: PerformanceProfile | undefined,
  recent429Count: number,
): number {
  const succ = profile
    ? Math.min(Math.max(readEWMA(profile.successRate, 0.5), 0), 1)
    : 0.5;
  const penalty = Math.min(1, Math.max(0, recent429Count) / TUNING.recent429Saturate);
  return succ * (1 - penalty);
}

// ============ 权重 ============

export interface Weights {
  speed: number;
  quality: number;
  load: number;
  stability: number;
}

/**
 * pref ∈ [0,1]: 0 = 最快, 1 = 最好
 *   w_speed   = 0.5 × (1 − pref)
 *   w_quality = 0.5 × pref
 *   w_load    = 0.3
 *   w_stability = 0.2
 * 四项恒等于 1；load/stability 固定是"不翻车底线"，不随 pref 变。
 */
export function weightsForPref(pref: number): Weights {
  const p = Math.min(Math.max(pref, 0), 1);
  return {
    speed: 0.5 * (1 - p),
    quality: 0.5 * p,
    load: 0.3,
    stability: 0.2,
  };
}

// ============ 综合评分 ============

export interface ScoreContext {
  tier: LatencyTier;
  /** routing.preference ∈ [0,1] */
  pref: number;
  /** ctx 原文总字符 —— 上游用于 context overflow 硬否决（不在评分里） */
  originalChars?: number;
}

export interface SlotSnapshot {
  profile?: PerformanceProfile;
  limits?: LimitProfile;
  circuit?: CircuitRecord;
  capability?: ProviderCapability;
  /** 最近 60s 内已消耗的 tokens（由 rate-limiter 或 liveState 读） */
  tokensInWindow?: number;
  /** 最近 60s 内 429 次数 */
  recent429Count?: number;
}

export interface ScoreBreakdown {
  score: number;
  rawScore: number;
  /** PROBING 态的权重折损；HEALTHY = 1 */
  probeWeight: number;
  weights: Weights;
  components: {
    speed: number;
    quality: number;
    load: number;
    stability: number;
  };
  /** 是否有足够数据；否则 UI 应标"未测" */
  isUntested: boolean;
}

/** 综合评分：raw ∈ [0,1]；PROBING 态再乘 probeWeight */
export function scoreSlot(snap: SlotSnapshot, ctx: ScoreContext): ScoreBreakdown {
  const weights = weightsForPref(ctx.pref);
  const rttEwma = snap.profile?.rttMs[ctx.tier];
  const hasRtt = rttEwma && rttEwma.count > 0;
  const spd = speedScore(hasRtt ? rttEwma.value : undefined);
  const qual = qualityScore(snap.profile);
  const load = loadHeadroom(snap.tokensInWindow ?? 0, snap.limits);
  const stab = stabilityScore(snap.profile, snap.recent429Count ?? 0);

  const raw =
    weights.speed * spd +
    weights.quality * qual +
    weights.load * load +
    weights.stability * stab;

  const probeWeight = snap.circuit?.state === 'PROBING' ? Math.max(0, snap.circuit.probeWeight) : 1;
  const score = Math.min(Math.max(raw * probeWeight, 0), 1);

  const isUntested = !hasRtt || !snap.profile || snap.profile.qualityScore.count === 0;

  return {
    score,
    rawScore: raw,
    probeWeight,
    weights,
    components: { speed: spd, quality: qual, load, stability: stab },
    isUntested,
  };
}

// ============ 硬性一票否决（§4.3）============

export interface VetoContext {
  /** 当前请求种类；影响 capability.batch 的 veto */
  kind: 'batch' | 'single' | 'super-fine-chunk';
  /** routing 配置（smart 模式下关心 preference；这里留个扩展位）*/
  routing?: RoutingSettings;
  /** 原文总字符；超出 capability.contextTokens 则被否决 */
  originalChars?: number;
  /** 请求是否强制关闭 thinking —— 用户在"高级 tab"关了，但 slot 强制思考则否决 */
  thinkingDisabledByUser?: boolean;
}

export interface VetoResult {
  vetoed: boolean;
  reason?: string;
}

export function vetoSlot(snap: SlotSnapshot, ctx: VetoContext, now: number = Date.now()): VetoResult {
  const c = snap.circuit;
  if (c?.state === 'PERMANENT_DISABLED') return { vetoed: true, reason: 'permanent_disabled' };
  if (c?.state === 'COOLING' && c.cooldownUntil > now) {
    return { vetoed: true, reason: `cooling_${Math.ceil((c.cooldownUntil - now) / 1000)}s` };
  }
  const cap = snap.capability;
  if (cap?.batch === 'broken' && ctx.kind === 'batch') {
    return { vetoed: true, reason: 'batch_broken' };
  }
  if (cap?.thinkingMode === 'forced' && ctx.thinkingDisabledByUser) {
    return { vetoed: true, reason: 'thinking_forced' };
  }
  if (cap?.contextTokens && ctx.originalChars) {
    // 粗估：1 token ≈ 4 字符（英文），中文更密 —— 用 3 作保守乘数留余量
    const estTokens = Math.ceil(ctx.originalChars / 3);
    if (estTokens > cap.contextTokens) {
      return { vetoed: true, reason: `context_overflow_${estTokens}>${cap.contextTokens}` };
    }
  }
  return { vetoed: false };
}
