/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { renderTranslation, linkifyText } from './render';

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
    // bilingual 不再克隆原文到 .dualang-original-html（避免切换跳动，见 render.ts 注释）；
    // 只保留 .dualang-bilingual 类和译文段，原文由 CSS 改色实现强调
    expect(article.querySelector('.dualang-bilingual')).toBeTruthy();
    expect(article.querySelector('.dualang-bilingual .dualang-para')).toBeTruthy();
    expect(article.querySelector('.dualang-bilingual .dualang-original-html')).toBeNull();
  });
});

describe('linkifyText', () => {
  it('纯文本无 URL：返回单个 text 节点', () => {
    const frag = linkifyText('Hello world no link here');
    const box = document.createElement('div');
    box.appendChild(frag);
    expect(box.querySelector('a')).toBeNull();
    expect(box.textContent).toBe('Hello world no link here');
  });

  it('单个 URL：包成 <a.dualang-link href=URL>', () => {
    const frag = linkifyText('Code: https://github.com/Tencent/MegaStyle');
    const box = document.createElement('div');
    box.appendChild(frag);
    const a = box.querySelector('a')!;
    expect(a).not.toBeNull();
    expect(a.getAttribute('href')).toBe('https://github.com/Tencent/MegaStyle');
    expect(a.textContent).toBe('https://github.com/Tencent/MegaStyle');
    expect(a.classList.contains('dualang-link')).toBe(true);
    expect(a.getAttribute('target')).toBe('_blank');
    expect(box.textContent).toBe('Code: https://github.com/Tencent/MegaStyle');
  });

  it('URL 后跟句末标点：标点不并入 href', () => {
    const frag = linkifyText('See https://example.com. Next sentence.');
    const box = document.createElement('div');
    box.appendChild(frag);
    expect(box.querySelector('a')!.getAttribute('href')).toBe('https://example.com');
    // 尾部 ". Next sentence." 仍为文本
    expect(box.textContent).toBe('See https://example.com. Next sentence.');
  });

  it('多个 URL 共存：各自独立 <a>', () => {
    const frag = linkifyText('A https://a.com/x B https://b.io/y end');
    const box = document.createElement('div');
    box.appendChild(frag);
    const links = box.querySelectorAll('a');
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('href')).toBe('https://a.com/x');
    expect(links[1].getAttribute('href')).toBe('https://b.io/y');
  });
});
