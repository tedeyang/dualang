/**
 * 路由器 Profile Recorder（P4）：
 * 把"真实翻译调用"的 RTT / 成功率 / token 效率 持续喂给 PerformanceProfile 做 EWMA 更新。
 *
 * 设计原则：
 *   1. Fire-and-forget：调用方 await 也行、不 await 也行，不阻塞翻译路径
 *   2. 不报错：provider 不在列表里、storage 暂时不可用，全部吞掉（只打日志）
 *   3. 只更新、不创建：provider 不存在不会自动补；让 migration 唯一负责创建
 *   4. 所有 I/O 走 storage.ts 的 per-key 锁（setInMap），避免 RMW 竞态
 */

import { updateEWMA, createEWMA } from '../../shared/ewma';
import type { LatencyTier, PerformanceProfile, CircuitRecord } from '../../shared/router-types';
import { createCircuitRecord } from '../../shared/router-types';
import {
  listProviders,
  getPerformance,
  setPerformance,
  getCircuit,
  setCircuit,
} from './storage';
import { transitionOnFailure, transitionOnSuccess } from './circuit';
import { cjkRatio, englishLeakRatio } from './sampler-validators';

export interface Outcome {
  /** 原文总字符数（用来决定放入 short/medium/long 哪个 tier） */
  originalChars: number;
  /** 调用耗时（ms） */
  rttMs: number;
  success: boolean;
  /** 本次消耗的总 tokens；缺失时不更新 tokensPerSec */
  totalTokens?: number;
  /** 如果失败，错误类型（429 / 5xx / net / etc.）—— 当前 P4 只影响 successRate；
   *  熔断/冷却由 P5 接手。*/
  errorKind?: string;
  /** 译文列表（P8 quality V1）：提供时从 cjkRatio/englishLeak 推导 qualityScore */
  translatedTexts?: string[];
}

/** 文本长度分桶：与 sampler 的 short/medium/long 统一语义。 */
export function tierOf(originalChars: number): LatencyTier {
  if (originalChars <= 120) return 'short';
  if (originalChars <= 600) return 'medium';
  return 'long';
}

/** 错误信息粗分类 —— 给 P5 熔断决策做线索；P4 只存字符串。 */
export function classifyErrorKind(err: any): string {
  if (!err) return 'unknown';
  if (err.name === 'AbortError') return 'abort';
  const msg = String(err.message || err).toLowerCase();
  if (/429|rate.?limit|tpm|too many/i.test(msg)) return 'rate_limit';
  if (/401|unauthorized|invalid.*key/i.test(msg)) return 'auth';
  if (/403|forbidden/i.test(msg)) return 'forbidden';
  if (/404|not found|model.*not.*exist/i.test(msg)) return 'not_found';
  if (/5\d\d|server error|overload/i.test(msg)) return 'server_error';
  if (/timeout|network|fetch/i.test(msg)) return 'network';
  return 'other';
}

/** 从 {model, baseUrl} 找 providerId；找不到返回 null（可能是用户直接用旧 settings 未迁移的 key）*/
export async function resolveProviderId(
  model: string | undefined,
  baseUrl: string | undefined,
): Promise<string | null> {
  if (!model || !baseUrl) return null;
  const providers = await listProviders();
  const match = providers.find((p) => p.model === model && p.baseUrl === baseUrl);
  return match?.id || null;
}

/**
 * V1 quality heuristic: maps cjkRatio + englishLeak to [0,1].
 * Weights (0.6/0.4) and thresholds are V1 calibration — revisit in V2.
 * Known blind spot: if translated text has no CJK (non-CJK target language),
 * returns 1.0 neutral; a future version should use target-lang hints.
 */
export function computeQualityScore(translations: string[]): number {
  if (!translations.length) return 1;
  let total = 0;
  for (const t of translations) {
    if (!t.trim()) { total += 0; continue; }
    const cjk = cjkRatio(t);
    if (cjk > 0.05) {
      const leak = englishLeakRatio(t);
      const cjkScore = Math.min(cjk / 0.5, 1);
      const leakScore = Math.max(1 - leak / 0.55, 0);
      total += cjkScore * 0.6 + leakScore * 0.4;
    } else {
      total += 1.0;
    }
  }
  return total / translations.length;
}

/** 纯函数：把 outcome 合并进 profile，返回新 profile。便于单测。*/
export function applyOutcome(
  prev: PerformanceProfile | undefined,
  outcome: Outcome,
): PerformanceProfile {
  const base = prev ?? emptyProfile();
  const tier = tierOf(outcome.originalChars);
  const rttMs = { ...base.rttMs };
  if (outcome.success && outcome.rttMs > 0) {
    rttMs[tier] = updateEWMA(rttMs[tier], outcome.rttMs);
  }
  let tokensPerSec = base.tokensPerSec;
  if (outcome.success && outcome.totalTokens && outcome.rttMs > 0) {
    const tps = (outcome.totalTokens * 1000) / outcome.rttMs;
    tokensPerSec = updateEWMA(tokensPerSec, tps);
  }
  const successRate = updateEWMA(base.successRate, outcome.success ? 1 : 0);
  let rawQuality: number;
  if (outcome.success && outcome.translatedTexts?.length) {
    rawQuality = computeQualityScore(outcome.translatedTexts);
  } else {
    rawQuality = outcome.success ? 1 : 0;
  }
  const qualityScore = updateEWMA(base.qualityScore, rawQuality);
  return {
    rttMs,
    tokensPerSec,
    successRate,
    qualityScore,
    lastSampleAt: Date.now(),
  };
}

function emptyProfile(): PerformanceProfile {
  return {
    rttMs: { short: createEWMA(), medium: createEWMA(), long: createEWMA() },
    tokensPerSec: createEWMA(),
    successRate: createEWMA(),
    qualityScore: createEWMA(),
    lastSampleAt: 0,
  };
}

/** 纯函数：根据 outcome 推导下一个 circuit 状态（只处理走到这里的那一次结果） */
export function nextCircuit(
  prev: CircuitRecord | undefined,
  outcome: Outcome,
  now: number = Date.now(),
): CircuitRecord {
  const base = prev ?? createCircuitRecord();
  if (outcome.success) return transitionOnSuccess(base, now);
  const kind = outcome.errorKind || 'other';
  return transitionOnFailure(base, kind, now);
}

/**
 * 主入口：解析 providerId → 读 profile + circuit → 合并 → 写回。
 * 任何一步失败都只打日志、吞掉异常；绝不向上冒泡打断翻译主路径。
 */
export async function recordOutcome(
  model: string | undefined,
  baseUrl: string | undefined,
  outcome: Outcome,
): Promise<void> {
  try {
    const id = await resolveProviderId(model, baseUrl);
    if (!id) return;
    const [prevPerf, prevCircuit] = await Promise.all([
      getPerformance(id),
      getCircuit(id),
    ]);
    const nextPerf = applyOutcome(prevPerf, outcome);
    const nextCirc = nextCircuit(prevCircuit, outcome);
    const writes: Promise<unknown>[] = [setPerformance(id, nextPerf)];
    // 只在 state/key 字段变化时写回，省 IO + 减少 onChanged 事件噪声
    if (!prevCircuit || circuitChanged(prevCircuit, nextCirc)) {
      writes.push(setCircuit(id, nextCirc));
    }
    await Promise.all(writes);
  } catch (e) {
    console.warn('[router.recorder] recordOutcome failed (ignored):', e);
  }
}

function circuitChanged(a: CircuitRecord, b: CircuitRecord): boolean {
  return (
    a.state !== b.state
    || a.cooldownUntil !== b.cooldownUntil
    || a.cooldownMs !== b.cooldownMs
    || a.probeWeight !== b.probeWeight
    || a.probeSuccessStreak !== b.probeSuccessStreak
  );
}
