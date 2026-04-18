import { describe, it, expect } from 'vitest';
import { normalizeText } from './types';

describe('normalizeText', () => {
  it('压缩连续空格', () => {
    expect(normalizeText('hello   world')).toBe('hello world');
  });
  it('保留单个换行', () => {
    expect(normalizeText('hello\nworld')).toBe('hello\nworld');
  });
  it('保留双换行（段落分隔）', () => {
    expect(normalizeText('para1\n\npara2')).toBe('para1\n\npara2');
  });
  it('压缩三个以上换行为双换行', () => {
    expect(normalizeText('para1\n\n\n\npara2')).toBe('para1\n\npara2');
  });
  it('trim 首尾空白', () => {
    expect(normalizeText('  hello  ')).toBe('hello');
  });
  it('tab 和混合空白压缩', () => {
    expect(normalizeText('hello\t\t  world')).toBe('hello world');
  });
  it('空字符串', () => {
    expect(normalizeText('')).toBe('');
  });
  it('相同文本产生相同结果（缓存一致性）', () => {
    const a = normalizeText('hello   world\n\n\npara2  ');
    const b = normalizeText('hello   world\n\n\npara2  ');
    expect(a).toBe(b);
  });
  it('仅空白差异的文本规范化后相同', () => {
    const a = normalizeText('hello  world');
    const b = normalizeText('hello world');
    expect(a).toBe(b);
  });
});
