/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderInlineSlots, clearInlineSlots, fillSlot } from './super-fine-render';
import { extractAnchoredBlocks } from './utils';

function setupArticle(html: string) {
  document.body.innerHTML = `<article data-testid="tweet"><div data-testid="twitterArticleRichTextView">${html}</div></article>`;
  return document.querySelector('article')!;
}

describe('renderInlineSlots', () => {
  it('每个 block 后面插入一个 skeleton slot', () => {
    const article = setupArticle(`<p>Hello</p><p>World</p>`);
    const body = article.querySelector('[data-testid="twitterArticleRichTextView"]')!;
    const blocks = extractAnchoredBlocks(body);
    renderInlineSlots(article, blocks);
    const slots = article.querySelectorAll('.dualang-inline-translation');
    expect(slots).toHaveLength(2);
    expect(slots[0].getAttribute('data-dualang-slot-index')).toBe('0');
    // slot 必须紧跟在对应原 block 后
    expect(blocks[0].el.nextElementSibling).toBe(slots[0]);
    expect(blocks[1].el.nextElementSibling).toBe(slots[1]);
  });

  it('图片段落 slot 带 img-alt 标记', () => {
    const article = setupArticle(`<p>Intro</p><figure><img alt="A chart"></figure>`);
    const body = article.querySelector('[data-testid="twitterArticleRichTextView"]')!;
    const blocks = extractAnchoredBlocks(body);
    renderInlineSlots(article, blocks);
    const slots = article.querySelectorAll('.dualang-inline-translation');
    expect(slots[1].classList.contains('dualang-inline-translation--img')).toBe(true);
  });
});

describe('fillSlot', () => {
  it('把译文写入对应 index 的 slot 并标记 filled', () => {
    const article = setupArticle(`<p>Hello</p><p>World</p>`);
    const body = article.querySelector('[data-testid="twitterArticleRichTextView"]')!;
    renderInlineSlots(article, extractAnchoredBlocks(body));
    fillSlot(article, 0, '你好');
    const slot0 = article.querySelector('[data-dualang-slot-index="0"]')!;
    expect(slot0.textContent).toBe('你好');
    expect(slot0.classList.contains('dualang-inline-translation--filled')).toBe(true);
  });
});

describe('clearInlineSlots', () => {
  it('移除全部 slot，原 DOM 保持', () => {
    const article = setupArticle(`<p>Hello</p><p>World</p>`);
    const body = article.querySelector('[data-testid="twitterArticleRichTextView"]')!;
    const originalHtml = body.innerHTML;
    renderInlineSlots(article, extractAnchoredBlocks(body));
    clearInlineSlots(article);
    expect(article.querySelectorAll('.dualang-inline-translation')).toHaveLength(0);
    expect(body.innerHTML).toBe(originalHtml);
  });
});
