import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTranslationCache } from './translation-cache';

describe('translationCache (multi-variant)', () => {
  it('match by current text — single variant', () => {
    const c = createTranslationCache();
    c.set('id1', { translated: 'T_A', original: 'A' });
    expect(c.match('id1', 'A')?.translated).toBe('T_A');
    expect(c.match('id1', 'B')).toBeUndefined();
  });

  it('multi-variant under same contentId — both retrievable, no eviction', () => {
    // 复现 bug 场景：X 的虚拟 DOM 让同一推文在截断态和完整态之间切换。
    // 老版本只存一个 variant，第二次 set 覆盖第一次 → 第一次的 DOM 状态再次出现时
    // currentText !== cached.original → stale → 作废 → 重翻 → 又作废 …
    const c = createTranslationCache();
    c.set('tweet1', { translated: 'short', original: 'truncated text' });    // len=14
    c.set('tweet1', { translated: 'long',  original: 'full longer text!!' }); // len=18

    expect(c.match('tweet1', 'truncated text')?.translated).toBe('short');
    expect(c.match('tweet1', 'full longer text!!')?.translated).toBe('long');
    expect(c.__test_variantCount('tweet1')).toBe(2);
  });

  it('upsert — same original replaces in place, no extra variant', () => {
    const c = createTranslationCache();
    c.set('id1', { translated: 'old', original: 'A', model: 'm1' });
    c.set('id1', { translated: 'new', original: 'A', model: 'm2' });
    expect(c.match('id1', 'A')?.translated).toBe('new');
    expect(c.match('id1', 'A')?.model).toBe('m2');
    expect(c.__test_variantCount('id1')).toBe(1);
  });

  it('per-bucket LRU — over variantsPerId pops the oldest', () => {
    const c = createTranslationCache({ variantsPerId: 3 });
    for (const t of ['A', 'B', 'C', 'D']) {
      c.set('id1', { translated: 'T_' + t, original: t });
    }
    expect(c.match('id1', 'A')).toBeUndefined();          // 最旧被弹
    expect(c.match('id1', 'D')?.translated).toBe('T_D');
    expect(c.__test_variantCount('id1')).toBe(3);
  });

  it('any() returns the most recently appended variant', () => {
    const c = createTranslationCache();
    c.set('id1', { translated: 'T_A', original: 'A' });
    c.set('id1', { translated: 'T_B', original: 'B' });
    expect(c.any('id1')?.original).toBe('B');
  });

  it('TTL — expired bucket is dropped on access', () => {
    vi.useFakeTimers();
    try {
      const c = createTranslationCache({ ttlMs: 1000 });
      c.set('id1', { translated: 'T', original: 'A' });
      vi.advanceTimersByTime(500);
      expect(c.match('id1', 'A')?.translated).toBe('T');
      vi.advanceTimersByTime(600);
      expect(c.match('id1', 'A')).toBeUndefined();
      expect(c.__test_variantCount('id1')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('global LRU — over maxBuckets pops the oldest contentId', () => {
    const c = createTranslationCache({ maxBuckets: 3 });
    c.set('id1', { translated: 'T1', original: 'A' });
    c.set('id2', { translated: 'T2', original: 'A' });
    c.set('id3', { translated: 'T3', original: 'A' });
    c.set('id4', { translated: 'T4', original: 'A' });   // id1 应被弹
    expect(c.match('id1', 'A')).toBeUndefined();
    expect(c.match('id4', 'A')?.translated).toBe('T4');
    expect(c.__test_size()).toBe(3);
  });

  it('repro of stale-loop bug: ping-pong between two variants never invalidates', () => {
    // 用户日志现场：cachedLen:39 currentLen:32 反复出现，每次循环都会触发
    // translate + dict.response。multi-variant 下两个文本各占一个 slot，
    // 任意状态下都是命中，不会触发 cache.invalidate.stale。
    const c = createTranslationCache();
    const FULL = 'F'.repeat(39);
    const TRUNC = 'T'.repeat(32);

    c.set('tweet', { translated: 'TR_FULL', original: FULL });
    c.set('tweet', { translated: 'TR_TRUNC', original: TRUNC });

    // 模拟 X 的 DOM 在两态之间切换 100 次：每次都应该是 cache hit
    let hits = 0, misses = 0;
    for (let i = 0; i < 100; i++) {
      const text = i % 2 === 0 ? FULL : TRUNC;
      if (c.match('tweet', text)) hits++;
      else misses++;
    }
    expect(hits).toBe(100);
    expect(misses).toBe(0);
    expect(c.__test_variantCount('tweet')).toBe(2);
  });

  it('delete drops the entire bucket', () => {
    const c = createTranslationCache();
    c.set('id1', { translated: 'T_A', original: 'A' });
    c.set('id1', { translated: 'T_B', original: 'B' });
    c.delete('id1');
    expect(c.match('id1', 'A')).toBeUndefined();
    expect(c.match('id1', 'B')).toBeUndefined();
  });
});
