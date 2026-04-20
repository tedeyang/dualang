import { describe, it, expect } from 'vitest';
import { splitNonEmptyLines, alignTranslatedLines } from './line-fusion';

describe('splitNonEmptyLines', () => {
  it('按换行切分并去掉空行', () => {
    expect(splitNonEmptyLines('A\n\nB\n  \nC')).toEqual(['A', 'B', 'C']);
  });
});

describe('alignTranslatedLines', () => {
  it('译文行数与原文一致时直接对齐', () => {
    const out = alignTranslatedLines(['one', 'two'], '一\n二');
    expect(out.confident).toBe(true);
    expect(out.lines).toEqual(['一', '二']);
  });

  it('译文单行时按句号重分组成原文行数（每组都非空 → confident）', () => {
    const out = alignTranslatedLines(['l1', 'l2', 'l3'], '甲。乙。丙。');
    expect(out.confident).toBe(true);
    expect(out.lines.length).toBe(3);
  });

  it('译文多于原文时不再强行合并尾部 —— 返回低置信', () => {
    const out = alignTranslatedLines(['one', 'two'], '一\n二\n三\n四');
    expect(out.confident).toBe(false);
  });

  it('译文少于原文时不再填空补位 —— 返回低置信', () => {
    const out = alignTranslatedLines(['one', 'two', 'three'], '一\n二');
    expect(out.confident).toBe(false);
  });

  it('严重不匹配（单行 + 原文多行）时返回低置信', () => {
    const out = alignTranslatedLines(['1', '2', '3', '4'], '只一行');
    expect(out.confident).toBe(false);
  });

  it('splitSentences 不拆 "Dr. Smith is amazing. Awesome."', () => {
    const out = alignTranslatedLines(['l1', 'l2'], 'Dr. Smith is amazing. Awesome.');
    // 应视为 2 句（"Dr. Smith is amazing." / "Awesome."），而非 3 句
    expect(out.confident).toBe(true);
    expect(out.lines.length).toBe(2);
    expect(out.lines[0]).toContain('Dr. Smith');
  });
});
