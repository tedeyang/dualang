/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { renderTranslation } from './render';

function setupArticle(textHtml: string) {
  document.body.innerHTML = `<article data-testid="tweet"><div data-testid="tweetText">${textHtml}</div></article>`;
  const article = document.querySelector('article') as Element;
  const tweetTextEl = article.querySelector('[data-testid="tweetText"]') as Element;
  return { article, tweetTextEl };
}

describe('renderTranslation line fusion', () => {
  it('bilingual + lineFusionEnabled 在多行时渲染 line-fusion pair（含原文+译文）', () => {
    const { article, tweetTextEl } = setupArticle('line1<br>line2');
    renderTranslation(
      article,
      tweetTextEl,
      '第一行\n第二行',
      'line1\nline2',
      'bilingual',
      { lineFusionEnabled: true },
    );
    expect(article.querySelectorAll('.dualang-line-fusion-pair')).toHaveLength(2);
    expect(article.querySelector('.dualang-line-fusion-orig')?.textContent).toContain('line1');
    expect(article.getAttribute('data-dualang-line-fusion')).toBe('true');
  });

  it('append + lineFusionEnabled 同样克隆原文行，并标记 data-dualang-line-fusion', () => {
    const { article, tweetTextEl } = setupArticle('line1<br>line2');
    renderTranslation(
      article,
      tweetTextEl,
      '第一行\n第二行',
      'line1\nline2',
      'append',
      { lineFusionEnabled: true },
    );
    const pairs = article.querySelectorAll('.dualang-line-fusion-pair');
    expect(pairs).toHaveLength(2);
    const origs = article.querySelectorAll('.dualang-line-fusion-orig');
    expect(origs).toHaveLength(2);
    expect(origs[0]!.textContent).toBe('line1');
    expect(origs[1]!.textContent).toBe('line2');
    expect(article.getAttribute('data-dualang-line-fusion')).toBe('true');
    expect(article.getAttribute('data-dualang-mode')).toBe('append');
  });

  it('单行原文不触发 line fusion', () => {
    const { article, tweetTextEl } = setupArticle('single line');
    renderTranslation(
      article,
      tweetTextEl,
      '单行译文',
      'single line',
      'append',
      { lineFusionEnabled: true },
    );
    expect(article.querySelector('.dualang-line-fusion-pair')).toBeNull();
    expect(article.getAttribute('data-dualang-line-fusion')).toBeNull();
    expect(article.querySelector('.dualang-para')).toBeTruthy();
  });

  it('line fusion 低置信时回退 bilingual 渲染，且不标记 fusion attr', () => {
    const { article, tweetTextEl } = setupArticle('a<br>b<br>c<br>d');
    renderTranslation(
      article,
      tweetTextEl,
      'only one line',
      'a\nb\nc\nd',
      'bilingual',
      { lineFusionEnabled: true },
    );
    expect(article.querySelector('.dualang-line-fusion-pair')).toBeNull();
    expect(article.getAttribute('data-dualang-line-fusion')).toBeNull();
    expect(article.querySelector('.dualang-bilingual .dualang-original-html')).toBeTruthy();
  });
});
