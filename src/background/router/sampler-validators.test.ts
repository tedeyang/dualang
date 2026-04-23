import { describe, it, expect } from 'vitest';
import {
  cjkRatio,
  hasCJK,
  englishLeakRatio,
  lengthRatio,
  validateTranslation,
  validateBatch,
  detectThinkingArtifacts,
} from './sampler-validators';

describe('cjkRatio', () => {
  it('pure CJK → 1.0', () => {
    expect(cjkRatio('你好世界')).toBeCloseTo(1);
  });
  it('empty → 0', () => {
    expect(cjkRatio('')).toBe(0);
  });
  it('half CJK half ASCII', () => {
    expect(cjkRatio('你好ab')).toBeCloseTo(0.5);
  });
});

describe('hasCJK', () => {
  it('detects single CJK', () => expect(hasCJK('hello 中')).toBe(true));
  it('rejects pure ASCII', () => expect(hasCJK('hello world')).toBe(false));
});

describe('englishLeakRatio', () => {
  it('zero on pure Chinese', () => {
    expect(englishLeakRatio('今天天气真好')).toBe(0);
  });
  it('counts 3+ letter runs', () => {
    const r = englishLeakRatio('hello 世界');
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(1);
  });
  it('ignores short tokens (1-2 letter OK for acronyms)', () => {
    expect(englishLeakRatio('AI 改变世界')).toBe(0); // AI only 2 letters
  });
});

describe('lengthRatio', () => {
  it('zero original → 0', () => expect(lengthRatio('', 'x')).toBe(0));
  it('1:1 → 1', () => expect(lengthRatio('abcd', 'abcd')).toBe(1));
});

describe('validateTranslation', () => {
  it('passes normal CN translation', () => {
    const v = validateTranslation('Hello world', '你好世界');
    expect(v.pass).toBe(true);
  });
  it('fails on empty', () => {
    const v = validateTranslation('Hello', '');
    expect(v.pass).toBe(false);
    expect(v.reasons.some((r) => r.includes('空输出'))).toBe(true);
  });
  it('fails on English leak', () => {
    const v = validateTranslation(
      'hello world good morning',
      'hello world good morning 你好',
    );
    expect(v.pass).toBe(false);
    expect(v.reasons.some((r) => r.includes('英文残留'))).toBe(true);
  });
  it('fails on too-short output', () => {
    const v = validateTranslation('a'.repeat(100), '你');
    expect(v.pass).toBe(false);
    expect(v.reasons.some((r) => r.includes('长度比'))).toBe(true);
  });
});

describe('validateBatch', () => {
  it('passes matched arrays', () => {
    const v = validateBatch(
      ['Hello', 'Good morning'],
      ['你好', '早上好'],
    );
    expect(v.pass).toBe(true);
    expect(v.countMatch).toBe(true);
  });
  it('fails on count mismatch', () => {
    const v = validateBatch(['a', 'b', 'c'], ['一', '二']);
    expect(v.countMatch).toBe(false);
    expect(v.pass).toBe(false);
  });
  it('aggregates per-item failures', () => {
    const v = validateBatch(
      ['Hello', 'Good morning'],
      ['你好', ''],
    );
    expect(v.pass).toBe(false);
    expect(v.reasons.some((r) => r.includes('第 2 条'))).toBe(true);
  });
});

describe('detectThinkingArtifacts', () => {
  it('matches <think>', () => {
    expect(detectThinkingArtifacts('<think>reasoning</think>你好')).toBe(true);
  });
  it('matches <|...|>', () => {
    expect(detectThinkingArtifacts('<|assistant|>你好')).toBe(true);
  });
  it('clean output returns false', () => {
    expect(detectThinkingArtifacts('你好世界')).toBe(false);
  });
});
