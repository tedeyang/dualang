import { describe, it, expect } from 'vitest';
import { createEWMA, updateEWMA, readEWMA, DEFAULT_WARMUP } from './ewma';

describe('EWMA', () => {
  it('warmup phase uses arithmetic mean', () => {
    let e = createEWMA();
    e = updateEWMA(e, 100);
    e = updateEWMA(e, 200);
    e = updateEWMA(e, 300);
    expect(e.value).toBeCloseTo(200);
    expect(e.count).toBe(3);
  });

  it('switches to EWMA after warmup', () => {
    let e = createEWMA();
    for (let i = 0; i < DEFAULT_WARMUP; i++) e = updateEWMA(e, 100);
    const before = e.value;
    e = updateEWMA(e, 1000, 0.25);
    // 0.25 * 1000 + 0.75 * 100 = 325
    expect(e.value).toBeCloseTo(325);
    expect(e.value).toBeGreaterThan(before);
  });

  it('ignores non-finite samples', () => {
    let e = createEWMA(100);
    const snapshot = { ...e };
    e = updateEWMA(e, NaN);
    expect(e).toEqual(snapshot);
    e = updateEWMA(e, Infinity);
    expect(e).toEqual(snapshot);
  });

  it('readEWMA falls back when uninitialized', () => {
    expect(readEWMA(undefined, 500)).toBe(500);
    expect(readEWMA(createEWMA(), 500)).toBe(500);
    expect(readEWMA(createEWMA(100), 500)).toBe(100);
  });
});
