import { describe, it, expect } from 'vitest';
import {
  transitionOnFailure,
  transitionOnSuccess,
  maybeUnfreeze,
  isPermanentErrorKind,
  isCoolingErrorKind,
  CIRCUIT_TUNING,
} from './circuit';
import { createCircuitRecord, type CircuitRecord } from '../../shared/router-types';

describe('error classification', () => {
  it('auth/forbidden/not_found → permanent', () => {
    expect(isPermanentErrorKind('auth')).toBe(true);
    expect(isPermanentErrorKind('forbidden')).toBe(true);
    expect(isPermanentErrorKind('not_found')).toBe(true);
    expect(isPermanentErrorKind('rate_limit')).toBe(false);
  });
  it('rate_limit/5xx/network/timeout/other → cooling', () => {
    expect(isCoolingErrorKind('rate_limit')).toBe(true);
    expect(isCoolingErrorKind('server_error')).toBe(true);
    expect(isCoolingErrorKind('network')).toBe(true);
    expect(isCoolingErrorKind('timeout')).toBe(true);
    expect(isCoolingErrorKind('other')).toBe(true);
    expect(isCoolingErrorKind('auth')).toBe(false);
  });
});

describe('transitionOnFailure', () => {
  const NOW = 1_000_000;

  it('HEALTHY + 429 → COOLING 60s', () => {
    const r = transitionOnFailure(createCircuitRecord(), 'rate_limit', NOW);
    expect(r.state).toBe('COOLING');
    expect(r.cooldownMs).toBe(60_000);
    expect(r.cooldownUntil).toBe(NOW + 60_000);
    expect(r.lastErrorKind).toBe('rate_limit');
  });

  it('HEALTHY + 5xx → COOLING 300s', () => {
    const r = transitionOnFailure(createCircuitRecord(), 'server_error', NOW);
    expect(r.state).toBe('COOLING');
    expect(r.cooldownMs).toBe(300_000);
  });

  it('HEALTHY + auth → PERMANENT_DISABLED', () => {
    const r = transitionOnFailure(createCircuitRecord(), 'auth', NOW);
    expect(r.state).toBe('PERMANENT_DISABLED');
    expect(r.cooldownMs).toBe(0);
  });

  it('HEALTHY + not_found → PERMANENT_DISABLED', () => {
    const r = transitionOnFailure(createCircuitRecord(), 'not_found', NOW);
    expect(r.state).toBe('PERMANENT_DISABLED');
  });

  it('PROBING failure → exponential backoff', () => {
    const probing = {
      ...createCircuitRecord(),
      state: 'PROBING' as const,
      cooldownMs: 60_000,
      probeWeight: 0.2,
      probeSuccessStreak: 1,
    };
    const r = transitionOnFailure(probing, 'rate_limit', NOW);
    expect(r.state).toBe('COOLING');
    expect(r.cooldownMs).toBe(120_000); // 60_000 × 2
    expect(r.cooldownUntil).toBe(NOW + 120_000);
    expect(r.probeSuccessStreak).toBe(0);
    expect(r.probeWeight).toBe(1);
  });

  it('PROBING failure caps at cooldownCapMs (30min)', () => {
    const probing = {
      ...createCircuitRecord(),
      state: 'PROBING' as const,
      cooldownMs: 20 * 60_000, // 20min
    };
    const r = transitionOnFailure(probing, 'rate_limit', NOW);
    expect(r.cooldownMs).toBe(CIRCUIT_TUNING.cooldownCapMs);
  });

  it('abort → no-op', () => {
    const prev = createCircuitRecord();
    expect(transitionOnFailure(prev, 'abort', NOW)).toBe(prev);
  });

  it('PERMANENT_DISABLED stays PERMANENT_DISABLED', () => {
    const perm = { ...createCircuitRecord(), state: 'PERMANENT_DISABLED' as const };
    expect(transitionOnFailure(perm, 'auth', NOW)).toBe(perm);
  });

  it('COOLING + more errors extends to max(remaining, initial)', () => {
    const cool = {
      ...createCircuitRecord(),
      state: 'COOLING' as const,
      cooldownMs: 60_000,
      cooldownUntil: NOW + 40_000, // 40s remaining
    };
    const r = transitionOnFailure(cool, 'rate_limit', NOW);
    // 40s remaining < 60s initial → new window = 60s
    expect(r.cooldownMs).toBe(60_000);
    expect(r.cooldownUntil).toBe(NOW + 60_000);
  });
});

describe('transitionOnSuccess', () => {
  const NOW = 1_000_000;

  it('HEALTHY stays HEALTHY', () => {
    const prev = createCircuitRecord();
    expect(transitionOnSuccess(prev, NOW)).toBe(prev);
  });

  it('PROBING success grows weight, increments streak', () => {
    const probing = {
      ...createCircuitRecord(),
      state: 'PROBING' as const,
      probeWeight: 0.1,
      probeSuccessStreak: 0,
    };
    const r = transitionOnSuccess(probing, NOW);
    expect(r.state).toBe('PROBING');
    expect(r.probeWeight).toBe(0.2);
    expect(r.probeSuccessStreak).toBe(1);
  });

  it('PROBING 3 consecutive successes → HEALTHY', () => {
    let r: CircuitRecord = {
      ...createCircuitRecord(),
      state: 'PROBING',
      probeWeight: 0.1,
      probeSuccessStreak: 0,
      cooldownMs: 60_000,
      cooldownUntil: NOW - 1000,
    };
    r = transitionOnSuccess(r, NOW);
    expect(r.probeSuccessStreak).toBe(1);
    r = transitionOnSuccess(r, NOW);
    expect(r.probeSuccessStreak).toBe(2);
    r = transitionOnSuccess(r, NOW);
    expect(r.state).toBe('HEALTHY');
    expect(r.cooldownMs).toBe(0);
    expect(r.cooldownUntil).toBe(0);
    expect(r.probeWeight).toBe(1);
    expect(r.probeSuccessStreak).toBe(0);
  });

  it('PROBING probeWeight caps at 1', () => {
    const probing = {
      ...createCircuitRecord(),
      state: 'PROBING' as const,
      probeWeight: 0.8,
      probeSuccessStreak: 2,
    };
    const r = transitionOnSuccess(probing, NOW);
    // streak → 3 → heals to HEALTHY, weight = 1
    expect(r.state).toBe('HEALTHY');
    expect(r.probeWeight).toBe(1);
  });

  it('PERMANENT_DISABLED ignores success', () => {
    const perm = { ...createCircuitRecord(), state: 'PERMANENT_DISABLED' as const };
    expect(transitionOnSuccess(perm, NOW)).toBe(perm);
  });
});

describe('maybeUnfreeze', () => {
  const NOW = 1_000_000;

  it('HEALTHY no-op', () => {
    const h = createCircuitRecord();
    expect(maybeUnfreeze(h, NOW)).toBe(h);
  });

  it('COOLING with cooldownUntil in future → no change', () => {
    const c = {
      ...createCircuitRecord(),
      state: 'COOLING' as const,
      cooldownUntil: NOW + 30_000,
    };
    expect(maybeUnfreeze(c, NOW)).toBe(c);
  });

  it('COOLING expired → PROBING with initial weight', () => {
    const c = {
      ...createCircuitRecord(),
      state: 'COOLING' as const,
      cooldownUntil: NOW - 1,
      cooldownMs: 60_000,
    };
    const r = maybeUnfreeze(c, NOW);
    expect(r.state).toBe('PROBING');
    expect(r.probeWeight).toBe(CIRCUIT_TUNING.probeInitialWeight);
    expect(r.probeSuccessStreak).toBe(0);
    // cooldownMs 保留 —— 失败时用它翻倍
    expect(r.cooldownMs).toBe(60_000);
  });

  it('PROBING no-op (already probing)', () => {
    const p = { ...createCircuitRecord(), state: 'PROBING' as const, probeWeight: 0.2 };
    expect(maybeUnfreeze(p, NOW)).toBe(p);
  });

  it('PERMANENT_DISABLED no-op', () => {
    const d = { ...createCircuitRecord(), state: 'PERMANENT_DISABLED' as const };
    expect(maybeUnfreeze(d, NOW)).toBe(d);
  });
});

describe('full lifecycle scenarios', () => {
  it('HEALTHY → 429 → cool 60s → PROBE → 3 successes → HEALTHY', () => {
    let r: CircuitRecord = createCircuitRecord();
    const t0 = 1_000_000;
    r = transitionOnFailure(r, 'rate_limit', t0);
    expect(r.state).toBe('COOLING');
    // 60s + 1ms 后
    r = maybeUnfreeze(r, t0 + 60_001);
    expect(r.state).toBe('PROBING');
    expect(r.probeWeight).toBe(0.1);
    r = transitionOnSuccess(r, t0 + 61_000);
    r = transitionOnSuccess(r, t0 + 62_000);
    r = transitionOnSuccess(r, t0 + 63_000);
    expect(r.state).toBe('HEALTHY');
  });

  it('repeated failure escalates cooldown: 60s → 120s → 240s', () => {
    let r: CircuitRecord = createCircuitRecord();
    let t = 1_000_000;
    r = transitionOnFailure(r, 'rate_limit', t);
    expect(r.cooldownMs).toBe(60_000);
    t += r.cooldownMs + 1;
    r = maybeUnfreeze(r, t);
    expect(r.state).toBe('PROBING');
    // Probing 再次失败
    r = transitionOnFailure(r, 'rate_limit', t);
    expect(r.cooldownMs).toBe(120_000);
    t += r.cooldownMs + 1;
    r = maybeUnfreeze(r, t);
    r = transitionOnFailure(r, 'rate_limit', t);
    expect(r.cooldownMs).toBe(240_000);
  });
});
