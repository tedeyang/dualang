/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import {
  isLikelyEnglishText,
  extractDictionaryCandidates,
  applyDictionaryAnnotations,
  clearDictionaryAnnotations,
} from './smart-dict';

describe('isLikelyEnglishText', () => {
  it('英文句子返回 true', () => {
    expect(isLikelyEnglishText('This is a difficult slang phrase.')).toBe(true);
  });

  it('中文句子返回 false', () => {
    expect(isLikelyEnglishText('这是一句中文。')).toBe(false);
  });
});

describe('extractDictionaryCandidates', () => {
  it('过滤 URL/@/# 和常见停用词', () => {
    const out = extractDictionaryCandidates('This cap is wild, check https://x.com @user #tag');
    expect(out.includes('this')).toBe(false);
    expect(out.includes('is')).toBe(false);
    expect(out.includes('cap')).toBe(true);
    expect(out.includes('wild')).toBe(true);
  });

  it('去重并保留大小写无关唯一词', () => {
    const out = extractDictionaryCandidates('Cap cap CAP vibe');
    // 'Cap' (title-case) / 'CAP' (all caps) 都被专名规则剔除；只有 'cap' / 'vibe' 小写 token 留下
    // 进一步："cap" 首次出现是 Cap 被跳，第二次 cap 留 → 去重 1 次
    expect(out.filter((w) => w === 'cap')).toHaveLength(1);
    expect(out).toContain('vibe');
  });

  it('跳过首字母大写的专有名词（球员名 / 品牌 / 缩写）', () => {
    const out = extractDictionaryCandidates(
      'Mitchell beats the shot clock with flair. NBA Cavs led.',
    );
    // Mitchell / NBA / Cavs 全部首字母大写 → 专名规则剔除
    expect(out).not.toContain('mitchell');
    expect(out).not.toContain('nba');
    expect(out).not.toContain('cavs');
    // 非专名应该保留（即使是常见词，后续靠 Zipf filter 过滤）
    expect(out).toContain('beats');
    expect(out).toContain('flair');
  });

  it('跳过英文缩略形式（he\'s / don\'t / they\'re）', () => {
    const out = extractDictionaryCandidates("he's got 27 PTS. don't miss the flair.");
    // he's / don't 含撇号 → 过滤；PTS 首字母大写 → 过滤；got 在 STOPWORDS 里 → 过滤
    // 最终只剩 miss / flair
    expect(out).not.toContain("he's");
    expect(out).not.toContain("don't");
    expect(out).not.toContain('pts');
    expect(out).toContain('miss');
    expect(out).toContain('flair');
  });
});

describe('applyDictionaryAnnotations', () => {
  function setup(text: string) {
    document.body.innerHTML = `<div id="root">${text}</div>`;
    return document.getElementById('root')!;
  }

  it('渲染格式为【释义 /ipa/】—— 译文在前，音标在后，不带 level 徽章', () => {
    const root = setup('amazing and mercurial and enigmatic people');
    applyDictionaryAnnotations(root, [
      { term: 'amazing', ipa: '/əˈmeɪzɪŋ/', gloss: '惊艳', level: 'cet6' },
      { term: 'mercurial', ipa: '/mɜːˈkjʊəriəl/', gloss: '善变', level: 'ielts' },
      { term: 'enigmatic', ipa: '/ˌenɪɡˈmætɪk/', gloss: '神秘', level: 'kaoyan' },
    ]);
    const defs = root.querySelectorAll<HTMLElement>('.dualang-dict-def');
    expect(defs).toHaveLength(3);
    expect(defs[0].textContent).toBe('【惊艳 /əˈmeɪzɪŋ/】');
    expect(defs[1].textContent).toBe('【善变 /mɜːˈkjʊəriəl/】');
    expect(defs[2].textContent).toBe('【神秘 /ˌenɪɡˈmætɪk/】');
    // 显示里不出现 level 徽章
    for (const d of Array.from(defs)) {
      expect(d.textContent).not.toMatch(/六级|雅思|考研/);
    }
    // 但 data-level 仍持久化（未来可做悬停提示 / 按难度统计）
    expect(defs[0].dataset.level).toBe('cet6');
    expect(defs[1].dataset.level).toBe('ielts');
    expect(defs[2].dataset.level).toBe('kaoyan');
  });

  it('缺 level 的条目正常渲染；data-level 不设置', () => {
    const root = setup('amazing people');
    applyDictionaryAnnotations(root, [
      { term: 'amazing', ipa: '/əˈmeɪzɪŋ/', gloss: '惊艳' },
    ]);
    const def = root.querySelector<HTMLElement>('.dualang-dict-def')!;
    expect(def.textContent).toBe('【惊艳 /əˈmeɪzɪŋ/】');
    expect(def.dataset.level).toBeUndefined();
  });

  it('只有 gloss 没 ipa 也能渲染', () => {
    const root = setup('amazing people');
    applyDictionaryAnnotations(root, [
      { term: 'amazing', ipa: '', gloss: '惊艳' },
    ]);
    const def = root.querySelector<HTMLElement>('.dualang-dict-def')!;
    expect(def.textContent).toBe('【惊艳】');
  });

  it('clearDictionaryAnnotations 完整移除 term + def，不残留文本', () => {
    const root = setup('amazing people');
    applyDictionaryAnnotations(root, [
      { term: 'amazing', ipa: '/əˈmeɪzɪŋ/', gloss: '惊艳', level: 'cet6' },
    ]);
    expect(root.textContent).toContain('惊艳');
    clearDictionaryAnnotations(root);
    expect(root.querySelector('.dualang-dict-term')).toBeNull();
    expect(root.textContent).toBe('amazing people');
  });
});
