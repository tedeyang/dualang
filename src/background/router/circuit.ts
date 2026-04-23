/**
 * 熔断状态机（设计 §4.4）。
 *
 *    HEALTHY ─(429/5xx/net)→ COOLING ─(cooldownUntil 到)→ PROBING
 *    PROBING ─(连续 3 次成功)→ HEALTHY
 *    PROBING ─(再失败)→ COOLING (cooldownMs × 2, 上限 30min)
 *    *       ─(401/403/404)→ PERMANENT_DISABLED
 *    AbortError 一律忽略（不算失败）。
 *
 * 关键原则：
 *   - 纯函数：只读输入 CircuitRecord，返回新 CircuitRecord；不做 I/O
 *   - 懒惰过期：cooldownUntil < now 才转 PROBING，由 maybeUnfreeze() 在 router
 *     select 时调用（不依赖 setTimeout，SW 重启依然正确）
 *   - probeWeight 乘法渐恢：0.1 → 0.2 → 0.4 → 0.8 → 1.0（3 次成功到健康）
 */

import type { CircuitRecord } from '../../shared/router-types';

export const CIRCUIT_TUNING = {
  /** 按 errorKind 分派初始冷却窗口（ms） */
  initialCooldownMs: {
    rate_limit: 60_000,     // 429
    server_error: 300_000,  // 5xx
    network: 60_000,
    timeout: 60_000,
    other: 60_000,          // 未知错默认短冷却；若确属坏 provider，下次再翻倍
  } as Record<string, number>,
  /** 冷却退避系数 */
  cooldownBackoffFactor: 2,
  /** 冷却窗口上限 */
  cooldownCapMs: 30 * 60_000,
  /** PROBING 初始权重 */
  probeInitialWeight: 0.1,
  /** 每次成功后权重乘以此系数，上限 1 */
  probeWeightGrowthFactor: 2,
  /** 连续成功达此数 → HEALTHY */
  probeSuccessStreakToHeal: 3,
} as const;

/** 分类：是否属于"永久禁用"错误（用户必须手动改 key 或删模型才能恢复） */
export function isPermanentErrorKind(errorKind: string): boolean {
  return errorKind === 'auth' || errorKind === 'forbidden' || errorKind === 'not_found';
}

/** 分类：是否属于"暂时冷却"错误（会进入 COOLING → PROBING 自愈流程） */
export function isCoolingErrorKind(errorKind: string): boolean {
  return (
    errorKind === 'rate_limit'
    || errorKind === 'server_error'
    || errorKind === 'network'
    || errorKind === 'timeout'
    || errorKind === 'other'
  );
}

function initialCooldownMs(errorKind: string): number {
  return CIRCUIT_TUNING.initialCooldownMs[errorKind] ?? 60_000;
}

/** 失败：根据错误类型推导下一个 state */
export function transitionOnFailure(
  prev: CircuitRecord,
  errorKind: string,
  now: number = Date.now(),
): CircuitRecord {
  // AbortError / delimiter 错 等不走熔断 —— 上层过滤后才调这个函数
  if (errorKind === 'abort') return prev;

  if (isPermanentErrorKind(errorKind)) {
    if (prev.state === 'PERMANENT_DISABLED') return prev;
    return {
      ...prev,
      state: 'PERMANENT_DISABLED',
      probeSuccessStreak: 0,
      probeWeight: 1,
      cooldownMs: 0,
      cooldownUntil: 0,
      lastErrorKind: errorKind,
      lastTransitionAt: now,
    };
  }

  if (!isCoolingErrorKind(errorKind)) return prev;

  const initial = initialCooldownMs(errorKind);
  let nextCooldownMs: number;
  if (prev.state === 'PROBING') {
    // 探测失败：上次冷却翻倍（取 max(prev, initial) 避免 0 × 2 = 0 的退化）
    nextCooldownMs = Math.min(
      Math.max(prev.cooldownMs || 0, initial) * CIRCUIT_TUNING.cooldownBackoffFactor,
      CIRCUIT_TUNING.cooldownCapMs,
    );
  } else if (prev.state === 'COOLING') {
    // 已在冷却中又收到新错误：延长到 max(已有余额, initial)，不翻倍（避免狂冷）
    const remaining = Math.max(0, prev.cooldownUntil - now);
    nextCooldownMs = Math.max(remaining, initial);
  } else {
    // HEALTHY → COOLING
    nextCooldownMs = initial;
  }

  return {
    ...prev,
    state: 'COOLING',
    cooldownUntil: now + nextCooldownMs,
    cooldownMs: nextCooldownMs,
    probeWeight: 1,
    probeSuccessStreak: 0,
    lastErrorKind: errorKind,
    lastTransitionAt: now,
  };
}

/** 成功：PROBING 渐进恢复；HEALTHY 原样返回；COOLING（罕见）也走恢复 */
export function transitionOnSuccess(
  prev: CircuitRecord,
  now: number = Date.now(),
): CircuitRecord {
  if (prev.state === 'HEALTHY') return prev;
  if (prev.state === 'PERMANENT_DISABLED') return prev; // 不应发生；保守忽略

  if (prev.state === 'PROBING') {
    const streak = prev.probeSuccessStreak + 1;
    if (streak >= CIRCUIT_TUNING.probeSuccessStreakToHeal) {
      return {
        ...prev,
        state: 'HEALTHY',
        cooldownMs: 0,
        cooldownUntil: 0,
        probeWeight: 1,
        probeSuccessStreak: 0,
        lastTransitionAt: now,
      };
    }
    const nextWeight = Math.min(
      prev.probeWeight * CIRCUIT_TUNING.probeWeightGrowthFactor,
      1,
    );
    return {
      ...prev,
      probeWeight: nextWeight,
      probeSuccessStreak: streak,
      lastTransitionAt: now,
    };
  }

  // COOLING 中收到 success（上层应该已 unfreeze 转 PROBING，这里兜底）
  return {
    ...prev,
    state: 'HEALTHY',
    cooldownMs: 0,
    cooldownUntil: 0,
    probeWeight: 1,
    probeSuccessStreak: 0,
    lastTransitionAt: now,
  };
}

/**
 * 懒惰解冻：COOLING 且 cooldownUntil ≤ now → 转 PROBING。
 * 不依赖 setTimeout；每次 router select 或 recorder recordOutcome 时调用。
 */
export function maybeUnfreeze(
  prev: CircuitRecord,
  now: number = Date.now(),
): CircuitRecord {
  if (prev.state !== 'COOLING') return prev;
  if (prev.cooldownUntil > now) return prev;
  return {
    ...prev,
    state: 'PROBING',
    probeWeight: CIRCUIT_TUNING.probeInitialWeight,
    probeSuccessStreak: 0,
    lastTransitionAt: now,
  };
}
