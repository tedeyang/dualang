import { describe, it, expect } from 'vitest';
import { deriveCapability, derivePerformance, type SamplerCaseResult } from './sampler';

const mk = (
  name: SamplerCaseResult['name'],
  ok: boolean,
  rtt: number,
  tokens?: number,
  outputHead = '你好世界',
): SamplerCaseResult => ({ name, ok, rttMs: rtt, tokens, outputHead });

describe('deriveCapability', () => {
  it('all-pass → batch proven / stream proven / thinking optional', () => {
    const cap = deriveCapability([
      mk('short-single', true, 800),
      mk('medium-single', true, 1500),
      mk('long-single', true, 3000),
      mk('batch-5', true, 2500),
      mk('stream-medium', true, 2000),
    ]);
    expect(cap.batch).toBe('proven');
    expect(cap.streaming).toBe('proven');
    expect(cap.thinkingMode).toBe('optional');
  });

  it('batch-5 failed → batch broken', () => {
    const cap = deriveCapability([
      mk('short-single', true, 800),
      mk('batch-5', false, 2500),
      mk('stream-medium', true, 2000),
    ]);
    expect(cap.batch).toBe('broken');
    expect(cap.streaming).toBe('proven');
  });

  it('missing case → untested', () => {
    const cap = deriveCapability([mk('short-single', true, 500)]);
    expect(cap.batch).toBe('untested');
    expect(cap.streaming).toBe('untested');
  });

  it('detects thinking artifacts in any output', () => {
    const cap = deriveCapability([
      mk('short-single', true, 800, undefined, '<think>reasoning</think>你好'),
    ]);
    expect(cap.thinkingMode).toBe('forced');
  });
});

describe('derivePerformance', () => {
  it('records rtt EWMA per tier on success', () => {
    const perf = derivePerformance([
      mk('short-single', true, 500),
      mk('medium-single', true, 1000),
      mk('long-single', true, 3000),
    ]);
    expect(perf.rttMs.short.value).toBe(500);
    expect(perf.rttMs.medium.value).toBe(1000);
    expect(perf.rttMs.long.value).toBe(3000);
    expect(perf.successRate.value).toBe(1);
  });

  it('skips rtt when case failed', () => {
    const perf = derivePerformance([
      mk('short-single', false, 500),
      mk('medium-single', true, 1000),
    ]);
    // failed short → uninitialized EWMA
    expect(perf.rttMs.short.count).toBe(0);
    expect(perf.rttMs.medium.value).toBe(1000);
    expect(perf.successRate.value).toBe(0.5);
  });

  it('tokensPerSec from successful cases', () => {
    const perf = derivePerformance([
      mk('short-single', true, 1000, 500),   // 500 tokens / 1s = 500 tps
      mk('medium-single', true, 1000, 500),
    ]);
    expect(perf.tokensPerSec.value).toBe(500);
  });

  it('tokensPerSec 0 when no successful sample', () => {
    const perf = derivePerformance([mk('short-single', false, 500)]);
    expect(perf.tokensPerSec.count).toBe(0);
  });
});
