import { describe, it, expect } from 'vitest';
import {
  speedScore,
  qualityScore,
  loadHeadroom,
  stabilityScore,
  weightsForPref,
  scoreSlot,
  vetoSlot,
  TUNING,
} from './scoring';
import { createEWMA, updateEWMA } from '../../shared/ewma';
import { createCircuitRecord, type PerformanceProfile } from '../../shared/router-types';

function mkProfile(overrides: Partial<PerformanceProfile> = {}): PerformanceProfile {
  return {
    rttMs: {
      short: createEWMA(),
      medium: createEWMA(),
      long: createEWMA(),
    },
    tokensPerSec: createEWMA(),
    successRate: createEWMA(),
    qualityScore: createEWMA(),
    lastSampleAt: 0,
    ...overrides,
  };
}

describe('speedScore', () => {
  it('100ms → 1.0', () => expect(speedScore(100)).toBeCloseTo(1));
  it('10s → 0.0', () => expect(speedScore(10_000)).toBeCloseTo(0));
  it('1s → ~0.5', () => expect(speedScore(1000)).toBeCloseTo(0.5, 2));
  it('below floor clamped', () => expect(speedScore(50)).toBeCloseTo(1));
  it('above ceiling clamped', () => expect(speedScore(30_000)).toBeCloseTo(0));
  it('missing → untested default', () => expect(speedScore(undefined)).toBe(TUNING.untestedSpeedScore));
  it('NaN → untested', () => expect(speedScore(NaN)).toBe(TUNING.untestedSpeedScore));
});

describe('qualityScore', () => {
  it('missing → 0.5 default', () => expect(qualityScore(undefined)).toBe(0.5));
  it('passes through EWMA value', () => {
    const p = mkProfile();
    p.qualityScore = createEWMA(0.8);
    expect(qualityScore(p)).toBe(0.8);
  });
  it('clamps >1 to 1', () => {
    const p = mkProfile();
    p.qualityScore = createEWMA(1.5);
    expect(qualityScore(p)).toBe(1);
  });
  it('unsampled → 0.5 default', () => {
    const p = mkProfile();
    expect(qualityScore(p)).toBe(0.5);
  });
});

describe('loadHeadroom', () => {
  it('no limits → default 50K cap', () => {
    expect(loadHeadroom(0, undefined)).toBe(1);
    expect(loadHeadroom(25_000, undefined)).toBe(0.5);
    expect(loadHeadroom(50_000, undefined)).toBe(0);
  });
  it('explicit tpmCap', () => {
    expect(loadHeadroom(1000, { free: true, tpmConfidence: 'measured', tpmCap: 10_000 })).toBe(0.9);
  });
  it('over cap → 0', () => {
    expect(loadHeadroom(60_000, { free: true, tpmConfidence: 'measured', tpmCap: 10_000 })).toBe(0);
  });
});

describe('stabilityScore', () => {
  it('no profile, no 429 → 0.5', () => {
    expect(stabilityScore(undefined, 0)).toBe(0.5);
  });
  it('successRate 1, 0 429 → 1', () => {
    const p = mkProfile();
    p.successRate = createEWMA(1);
    expect(stabilityScore(p, 0)).toBe(1);
  });
  it('429 = saturate → zeros', () => {
    const p = mkProfile();
    p.successRate = createEWMA(1);
    expect(stabilityScore(p, TUNING.recent429Saturate)).toBe(0);
  });
  it('mid-range multiplier', () => {
    const p = mkProfile();
    p.successRate = createEWMA(0.8);
    // penalty = 2/5 = 0.4; 0.8 × 0.6 = 0.48
    expect(stabilityScore(p, 2)).toBeCloseTo(0.48);
  });
});

describe('weightsForPref', () => {
  it('pref=0 → all weight on speed+load+stability', () => {
    const w = weightsForPref(0);
    expect(w.speed).toBe(0.5);
    expect(w.quality).toBe(0);
    expect(w.load).toBe(0.3);
    expect(w.stability).toBe(0.2);
    expect(w.speed + w.quality + w.load + w.stability).toBeCloseTo(1);
  });
  it('pref=1 → all weight on quality+load+stability', () => {
    const w = weightsForPref(1);
    expect(w.speed).toBe(0);
    expect(w.quality).toBe(0.5);
    expect(w.speed + w.quality + w.load + w.stability).toBeCloseTo(1);
  });
  it('pref=0.5 → balanced', () => {
    const w = weightsForPref(0.5);
    expect(w.speed).toBe(0.25);
    expect(w.quality).toBe(0.25);
    expect(w.load).toBe(0.3);
    expect(w.stability).toBe(0.2);
  });
  it('clamps out-of-range', () => {
    expect(weightsForPref(-1)).toEqual(weightsForPref(0));
    expect(weightsForPref(2)).toEqual(weightsForPref(1));
  });
});

describe('scoreSlot — happy path', () => {
  it('healthy, fast, high quality → high score', () => {
    const p = mkProfile();
    p.rttMs.short = createEWMA(200);  // fast
    p.qualityScore = createEWMA(0.9);
    p.successRate = createEWMA(1);
    const s = scoreSlot(
      { profile: p, tokensInWindow: 0 },
      { tier: 'short', pref: 0.5 },
    );
    expect(s.score).toBeGreaterThan(0.7);
    expect(s.probeWeight).toBe(1);
    expect(s.isUntested).toBe(false);
  });

  it('untested → isUntested true + neutral score', () => {
    const s = scoreSlot({}, { tier: 'short', pref: 0.5 });
    expect(s.isUntested).toBe(true);
    // speed 0.5 × 0.25 + quality 0.5 × 0.25 + load 1 × 0.3 + stability 0.5 × 0.2 = 0.65
    expect(s.score).toBeCloseTo(0.65);
  });

  it('PROBING state × probeWeight 0.1', () => {
    const p = mkProfile();
    p.rttMs.short = createEWMA(200);
    p.qualityScore = createEWMA(0.9);
    p.successRate = createEWMA(1);
    const circuit = { ...createCircuitRecord(), state: 'PROBING' as const, probeWeight: 0.1 };
    const healthyScore = scoreSlot({ profile: p }, { tier: 'short', pref: 0.5 }).score;
    const probingScore = scoreSlot({ profile: p, circuit }, { tier: 'short', pref: 0.5 }).score;
    expect(probingScore).toBeCloseTo(healthyScore * 0.1);
  });

  it('high load → score drops even with fast rtt', () => {
    const p = mkProfile();
    p.rttMs.short = createEWMA(100);
    p.qualityScore = createEWMA(1);
    p.successRate = createEWMA(1);
    const low = scoreSlot({ profile: p, tokensInWindow: 0 }, { tier: 'short', pref: 0.5 });
    const high = scoreSlot({ profile: p, tokensInWindow: 45_000 }, { tier: 'short', pref: 0.5 });
    expect(high.score).toBeLessThan(low.score);
  });

  it('score stays in [0,1] under all conditions', () => {
    // EWMA value clamped via clamp inside qualityScore; verify outputs
    const p = mkProfile();
    p.rttMs.short = createEWMA(100);
    p.qualityScore = createEWMA(1);
    p.successRate = createEWMA(1);
    const s = scoreSlot({ profile: p, tokensInWindow: 0 }, { tier: 'short', pref: 0 });
    expect(s.score).toBeLessThanOrEqual(1);
    expect(s.score).toBeGreaterThanOrEqual(0);
  });
});

describe('vetoSlot', () => {
  it('healthy passes', () => {
    expect(vetoSlot({}, { kind: 'batch' }).vetoed).toBe(false);
  });

  it('PERMANENT_DISABLED vetoed', () => {
    const circuit = { ...createCircuitRecord(), state: 'PERMANENT_DISABLED' as const };
    expect(vetoSlot({ circuit }, { kind: 'batch' }).vetoed).toBe(true);
  });

  it('COOLING with cooldownUntil > now vetoed', () => {
    const circuit = {
      ...createCircuitRecord(),
      state: 'COOLING' as const,
      cooldownUntil: Date.now() + 60_000,
    };
    expect(vetoSlot({ circuit }, { kind: 'batch' }).vetoed).toBe(true);
  });

  it('COOLING past cooldownUntil not vetoed here (lazy transition upstream)', () => {
    const circuit = {
      ...createCircuitRecord(),
      state: 'COOLING' as const,
      cooldownUntil: Date.now() - 1000,
    };
    expect(vetoSlot({ circuit }, { kind: 'batch' }).vetoed).toBe(false);
  });

  it('batch=broken vetoed for batch kind, not for single', () => {
    const capability = {
      batch: 'broken' as const,
      streaming: 'proven' as const,
      thinkingMode: 'optional' as const,
      observedAt: 0,
    };
    expect(vetoSlot({ capability }, { kind: 'batch' }).vetoed).toBe(true);
    expect(vetoSlot({ capability }, { kind: 'single' }).vetoed).toBe(false);
  });

  it('thinking forced & user disabled it → vetoed', () => {
    const capability = {
      batch: 'proven' as const,
      streaming: 'proven' as const,
      thinkingMode: 'forced' as const,
      observedAt: 0,
    };
    expect(vetoSlot({ capability }, { kind: 'batch', thinkingDisabledByUser: true }).vetoed).toBe(true);
    expect(vetoSlot({ capability }, { kind: 'batch' }).vetoed).toBe(false);
  });

  it('context overflow → vetoed', () => {
    const capability = {
      batch: 'proven' as const,
      streaming: 'proven' as const,
      thinkingMode: 'optional' as const,
      observedAt: 0,
      contextTokens: 8192,
    };
    // 30k 字符 ≈ 10k token，超 8192
    expect(vetoSlot({ capability }, { kind: 'batch', originalChars: 30_000 }).vetoed).toBe(true);
    // 9k 字符 ≈ 3k token
    expect(vetoSlot({ capability }, { kind: 'batch', originalChars: 9_000 }).vetoed).toBe(false);
  });
});
