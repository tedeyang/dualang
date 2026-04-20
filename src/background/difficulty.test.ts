import { describe, it, expect } from 'vitest';
import { analyzeWord, filterHardCandidates, syllableCount } from './difficulty';

describe('syllableCount', () => {
  it('短词均视为单音节', () => {
    expect(syllableCount('cat')).toBe(1);
    expect(syllableCount('at')).toBe(1);
  });

  it('末尾哑 e 扣一（"make"=1, "time"=1）', () => {
    expect(syllableCount('make')).toBe(1);
    expect(syllableCount('time')).toBe(1);
    // "create" 两音节 cre-ate
    expect(syllableCount('create')).toBe(2);
  });

  it('末尾 le 作为独立音节（"able"=2, "table"=2）', () => {
    expect(syllableCount('able')).toBe(2);
    expect(syllableCount('table')).toBe(2);
  });

  it('长词 ~ 多音节', () => {
    expect(syllableCount('beautiful')).toBeGreaterThanOrEqual(3);
    expect(syllableCount('mercurial')).toBeGreaterThanOrEqual(3);
    expect(syllableCount('enigmatic')).toBeGreaterThanOrEqual(4);
  });
});

describe('analyzeWord', () => {
  it('常见词（the / have）→ 低难度 level=0', () => {
    const r = analyzeWord('have');
    expect(r.zipf).toBeGreaterThanOrEqual(6); // 在 COMMON_EN_WORDS 里
    expect(r.level).toBe(0);
  });

  it('未登录罕见词 → 高难度 level ≥ 2', () => {
    const r = analyzeWord('mercurial');
    expect(r.zipf).toBeLessThanOrEqual(3); // 不在表里
    expect(r.freqScore).toBeGreaterThan(0.5);
    expect(r.level).toBeGreaterThanOrEqual(2);
  });

  it('domainBoost 命中时难度提升', () => {
    const domain = new Set(['framework']);
    const r1 = analyzeWord('framework');
    const r2 = analyzeWord('framework', { domainWords: domain });
    expect(r2.rawScore).toBeGreaterThan(r1.rawScore);
  });

  it('输入自动 lowercase + trim', () => {
    const r = analyzeWord('  MERCURIAL  ');
    expect(r.word).toBe('mercurial');
  });
});

describe('filterHardCandidates', () => {
  it('过滤掉常见词，保留未登录 / 高难词', () => {
    const out = filterHardCandidates(['have', 'the', 'mercurial', 'enigmatic', 'go']);
    expect(out).toContain('mercurial');
    expect(out).toContain('enigmatic');
    expect(out).not.toContain('have');
    expect(out).not.toContain('the');
    expect(out).not.toContain('go');
  });

  it('按难度降序返回，最多 max 个', () => {
    const out = filterHardCandidates(
      ['mercurial', 'capricious', 'ephemeral', 'enigmatic', 'loquacious', 'obscure'],
      { max: 3 },
    );
    expect(out).toHaveLength(3);
  });

  it('阈值太高时返回空数组（降级为不发 API）', () => {
    const out = filterHardCandidates(['have', 'the', 'go'], { threshold: 0.9 });
    expect(out).toEqual([]);
  });

  it('domain 词典加权影响排序', () => {
    const withDomain = filterHardCandidates(['kubectl', 'helm', 'obscure'], {
      threshold: 0.4, max: 3,
      domainWords: new Set(['kubectl', 'helm']),
    });
    // kubectl / helm 有领域 boost；obscure 也可能上榜
    expect(withDomain).toContain('kubectl');
  });

  it('屈折回退：beats → beat / heading → head / easier → easy 都被判"常见"过滤掉', () => {
    const out = filterHardCandidates(['beats', 'heading', 'easier', 'shots', 'walking', 'mercurial']);
    // 这些屈折形态的原形都在 COMMON_EN_WORDS 里，应该被筛掉，只剩真难词
    expect(out).not.toContain('beats');
    expect(out).not.toContain('heading');
    expect(out).not.toContain('easier');
    expect(out).not.toContain('shots');
    expect(out).not.toContain('walking');
    expect(out).toContain('mercurial');
  });

  it('NBA 球赛推文实例：只有 flair 是真难词', () => {
    // 来自真实场景："Mitchell beats the shot clock with flair. He got 27 PTS ..."
    // content 端已经过滤了专名（Mitchell）、缩写（NBA/PTS）、apostrophe（He's）
    // 这里只测难度过滤是否把"beat/shot/clock/got/heading"这类 cet4 级别正确识别为简单
    const out = filterHardCandidates(['beats', 'shot', 'clock', 'got', 'lead', 'heading', 'flair']);
    expect(out).toEqual(['flair']);
  });
});
