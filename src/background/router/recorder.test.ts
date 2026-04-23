import { describe, it, expect } from 'vitest';
import { tierOf, applyOutcome, nextCircuit } from './recorder';
import { createEWMA } from '../../shared/ewma';
import { createCircuitRecord, type PerformanceProfile } from '../../shared/router-types';

describe('tierOf', () => {
  it('short ≤ 120 chars', () => {
    expect(tierOf(0)).toBe('short');
    expect(tierOf(120)).toBe('short');
  });
  it('medium 121-600', () => {
    expect(tierOf(121)).toBe('medium');
    expect(tierOf(600)).toBe('medium');
  });
  it('long > 600', () => {
    expect(tierOf(601)).toBe('long');
    expect(tierOf(5000)).toBe('long');
  });
});

function emptyProfile(): PerformanceProfile {
  return {
    rttMs: { short: createEWMA(), medium: createEWMA(), long: createEWMA() },
    tokensPerSec: createEWMA(),
    successRate: createEWMA(),
    qualityScore: createEWMA(),
    lastSampleAt: 0,
  };
}

describe('applyOutcome', () => {
  it('creates empty profile when prev missing', () => {
    const p = applyOutcome(undefined, { originalChars: 50, rttMs: 500, success: true });
    expect(p.rttMs.short.value).toBe(500);
    expect(p.successRate.value).toBe(1);
    expect(p.qualityScore.value).toBe(1);
    expect(p.lastSampleAt).toBeGreaterThan(0);
  });

  it('routes RTT to correct tier', () => {
    const p = applyOutcome(emptyProfile(), { originalChars: 300, rttMs: 1500, success: true });
    expect(p.rttMs.short.count).toBe(0);
    expect(p.rttMs.medium.value).toBe(1500);
    expect(p.rttMs.long.count).toBe(0);
  });

  it('drops RTT on failure (still updates successRate)', () => {
    const p = applyOutcome(emptyProfile(), {
      originalChars: 50, rttMs: 5000, success: false,
    });
    expect(p.rttMs.short.count).toBe(0);
    expect(p.successRate.value).toBe(0);
    expect(p.qualityScore.value).toBe(0);
  });

  it('updates tokensPerSec when tokens present', () => {
    const p = applyOutcome(emptyProfile(), {
      originalChars: 50, rttMs: 1000, success: true, totalTokens: 500,
    });
    expect(p.tokensPerSec.value).toBe(500); // 500 tokens / 1s
  });

  it('skips tokensPerSec update when totalTokens missing', () => {
    const p = applyOutcome(emptyProfile(), {
      originalChars: 50, rttMs: 1000, success: true,
    });
    expect(p.tokensPerSec.count).toBe(0);
  });

  it('EWMA smoothing on second sample', () => {
    let p = applyOutcome(undefined, { originalChars: 50, rttMs: 1000, success: true });
    p = applyOutcome(p, { originalChars: 50, rttMs: 2000, success: true });
    // warmup averages to 1500
    expect(p.rttMs.short.value).toBe(1500);
  });

  it('successRate drops on mixed outcomes', () => {
    let p = applyOutcome(undefined, { originalChars: 50, rttMs: 500, success: true });
    p = applyOutcome(p, { originalChars: 50, rttMs: 500, success: false });
    p = applyOutcome(p, { originalChars: 50, rttMs: 500, success: false });
    expect(p.successRate.value).toBeCloseTo(1 / 3);
  });

  it('ignores non-finite RTT', () => {
    const p = applyOutcome(emptyProfile(), {
      originalChars: 50, rttMs: NaN, success: true,
    });
    expect(p.rttMs.short.count).toBe(0);
  });
});

describe('nextCircuit', () => {
  const NOW = 1_000_000;

  it('no prev circuit + success → HEALTHY', () => {
    const c = nextCircuit(undefined, { originalChars: 50, rttMs: 500, success: true }, NOW);
    expect(c.state).toBe('HEALTHY');
  });

  it('no prev circuit + 429 → COOLING', () => {
    const c = nextCircuit(undefined, {
      originalChars: 50, rttMs: 500, success: false, errorKind: 'rate_limit',
    }, NOW);
    expect(c.state).toBe('COOLING');
    expect(c.cooldownMs).toBe(60_000);
  });

  it('auth error → PERMANENT_DISABLED', () => {
    const c = nextCircuit(undefined, {
      originalChars: 50, rttMs: 500, success: false, errorKind: 'auth',
    }, NOW);
    expect(c.state).toBe('PERMANENT_DISABLED');
  });

  it('PROBING + success grows weight', () => {
    const probing = { ...createCircuitRecord(), state: 'PROBING' as const, probeWeight: 0.1 };
    const c = nextCircuit(probing, { originalChars: 50, rttMs: 500, success: true }, NOW);
    expect(c.state).toBe('PROBING');
    expect(c.probeWeight).toBe(0.2);
  });

  it('abort does not disturb state', () => {
    const prev = createCircuitRecord();
    const c = nextCircuit(prev, {
      originalChars: 50, rttMs: 0, success: false, errorKind: 'abort',
    }, NOW);
    expect(c).toBe(prev);
  });
});
