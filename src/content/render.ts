import { rebuildParagraphs, splitParagraphsByDom } from './utils';
import { telemetry } from './telemetry';
import type { DisplayMode } from './display-mode';
import { splitNonEmptyLines, alignTranslatedLines } from './line-fusion';

type RenderEnhancements = {
  lineFusionEnabled?: boolean;
};

/**
 * 渲染翻译块。4 种展示模式：
 *   - append          —— 原文 tweetText 保留可见，译文 card 追加在其下方
 *   - translation-only —— 原文隐藏（CSS 靠 article[data-dualang-mode] 属性选择器），只显示译文
 *   - inline          —— 原文隐藏；card 内逐段交错：[克隆原文段落 HTML] + [对应译文]
 *   - bilingual       —— 原文隐藏；card 内先整段原文 HTML 克隆，下方跟整段译文
 *
 * 为什么用 data-dualang-mode 属性（而不是 className）：mode 切换时，
 * 旧推文保留老模式、新推文用新模式 —— 属性选择器按 article 自己的 mode
 * 决定是否隐藏 tweetTextEl，互不影响。
 *
 * 副作用：在 article 上设置 data-dualang-mode、把 card 插到 tweetTextEl 之后、
 * 调用 onRendered 回调（通常是 unobserveArticle）。
 */
export function renderTranslation(
  article: Element,
  tweetTextEl: Element,
  translatedText: string,
  originalText: string,
  displayMode: DisplayMode,
  enhancements: RenderEnhancements = {},
  onRendered?: (article: Element) => void,
): void {
  const t0 = performance.now();
  if (article.querySelector('.dualang-translation')) return;

  const card = document.createElement('div');
  card.className = 'dualang-translation';
  article.setAttribute('data-dualang-mode', displayMode);

  let translatedParas = translatedText
    .split(/(?:\n\s*\n|---PARA---)/)
    .map(p => p.trim())
    .filter(Boolean);
  if (translatedParas.length === 0) translatedParas.push(translatedText.trim());

  // 译文救援：模型没有按"保留段落"指令输出 \n\n，但原文确实有多段落 →
  // 按句末标点重建段落结构，避免渲染成一大坨文字
  if (translatedParas.length === 1 && originalText) {
    const origParas = originalText.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).length;
    if (origParas >= 3) {
      const rebuilt = rebuildParagraphs(translatedParas[0], origParas);
      if (rebuilt.length >= 2) {
        translatedParas = rebuilt;
        telemetry.perf('paraRebuild', { origParas, newParas: rebuilt.length });
      }
    }
  }

  const canLineFusion = !!enhancements.lineFusionEnabled
    && (displayMode === 'append' || displayMode === 'bilingual')
    && splitNonEmptyLines(originalText).length >= 2;

  let renderedByFusion = false;
  if (canLineFusion) {
    const origLines = splitNonEmptyLines(originalText);
    const aligned = alignTranslatedLines(origLines, translatedText);
    if (aligned.confident && aligned.lines.length > 0) {
      card.classList.add('dualang-line-fusion');
      // data-dualang-line-fusion 驱动 CSS 隐藏 tweetText —— append 模式下原文行已经在
      // card 里的每个 pair 中，页面上再保留一份 tweetText 会出现"原文两次 + 孤立分隔线"
      article.setAttribute('data-dualang-line-fusion', 'true');
      renderLineFusion(card, origLines, aligned.lines);
      renderedByFusion = true;
    }
  }

  if (!renderedByFusion && displayMode === 'inline') {
    // 段落对照：按 DOM 边界克隆原文各段，紧接对应译文；段数不对等时取原文为准
    card.classList.add('dualang-inline');
    const originalParas = splitParagraphsByDom(tweetTextEl);
    // 段数严重不匹配（X Articles 的原文 DOM 靠 CSS block 布局切段，\n\n 分隔不准）
    // → 退回整体对照布局避免大量译文散落在末尾
    const severeMismatch = originalParas.length > 0
      && translatedParas.length > 2
      && originalParas.length < translatedParas.length * 0.5;
    if (originalParas.length === 0 || severeMismatch) {
      // 退化路径：整段原文克隆 + 整块译文（bilingual 风格）
      const origBlock = document.createElement('div');
      origBlock.className = 'dualang-original-html';
      for (const child of Array.from(tweetTextEl.childNodes) as Node[]) {
        origBlock.appendChild(child.cloneNode(true));
      }
      card.appendChild(origBlock);
      appendTranslationParas(card, translatedParas);
      if (severeMismatch) {
        telemetry.perf('inline.fallbackToBilingual', {
          origParas: originalParas.length, transParas: translatedParas.length,
        });
      }
    } else {
      for (let i = 0; i < originalParas.length; i++) {
        const pair = document.createElement('div');
        pair.className = 'dualang-inline-pair';
        const orig = document.createElement('div');
        orig.className = 'dualang-original-html';
        orig.appendChild(originalParas[i]);
        pair.appendChild(orig);
        if (translatedParas[i]) {
          const trans = document.createElement('div');
          trans.className = 'dualang-para';
          trans.textContent = translatedParas[i];
          pair.appendChild(trans);
        }
        card.appendChild(pair);
      }
      // 译文多出的尾段：按一段译文块追加
      for (let i = originalParas.length; i < translatedParas.length; i++) {
        const trans = document.createElement('div');
        trans.className = 'dualang-para';
        trans.textContent = translatedParas[i];
        card.appendChild(trans);
      }
    }
  } else if (!renderedByFusion && displayMode === 'bilingual') {
    // 整体对照：克隆整段原文 HTML（保留链接/emoji/@/#）+ 整段译文
    card.classList.add('dualang-bilingual');
    const origBlock = document.createElement('div');
    origBlock.className = 'dualang-original-html';
    for (const child of Array.from(tweetTextEl.childNodes) as Node[]) {
      origBlock.appendChild(child.cloneNode(true));
    }
    card.appendChild(origBlock);
    appendTranslationParas(card, translatedParas);
  } else if (!renderedByFusion) {
    // 'append' 和 'translation-only' 共享译文-only 的 card 结构；
    // 区别只在 CSS 是否隐藏 tweetTextEl（由 data-dualang-mode 控制）
    appendTranslationParas(card, translatedParas);
  }

  tweetTextEl.parentNode!.insertBefore(card, tweetTextEl.nextSibling);
  onRendered?.(article);
  const cost = performance.now() - t0;
  telemetry.inc('renderCalls');
  telemetry.add('renderTotalTime', cost);
  telemetry.perf('render', { paras: translatedParas.length, mode: displayMode, costMs: cost.toFixed(2) });
}

// 原文行和译文行在每个 pair 内同时出现；append/bilingual 的"强调侧"由 CSS 按
// data-dualang-mode 做颜色区分。不在 pair 里出现原文（旧版 bilingual-only 分支）会
// 让 append 模式下的 card 变成孤立的"分隔线 + 译文"列，与页面上未隐藏的 tweetText 视觉脱节。
function renderLineFusion(
  card: HTMLElement,
  originalLines: string[],
  translatedLines: string[],
): void {
  for (let i = 0; i < translatedLines.length; i++) {
    const pair = document.createElement('div');
    pair.className = 'dualang-line-fusion-pair';
    if (originalLines[i]) {
      const orig = document.createElement('div');
      orig.className = 'dualang-line-fusion-orig';
      orig.textContent = originalLines[i];
      pair.appendChild(orig);
    }
    const divider = document.createElement('div');
    divider.className = 'dualang-line-fusion-divider';
    pair.appendChild(divider);

    const trans = document.createElement('div');
    trans.className = 'dualang-line-fusion-trans';
    trans.textContent = translatedLines[i];
    pair.appendChild(trans);
    card.appendChild(pair);
  }
}

/**
 * 渲染整段译文：把多个段落合并回一个 pre-wrap 块，\n\n 由 CSS 的 white-space 原生
 * 渲染为一整行空行（与 X.com 原生 tweetText 的段落间距视觉一致）。
 * 旧做法是每段一个 <div> + margin-top 近似，但 margin 值永远对不齐 line-height 撑出的空行。
 */
function appendTranslationParas(card: HTMLElement, translatedParas: string[]): void {
  if (translatedParas.length === 0) return;
  const p = document.createElement('div');
  p.className = 'dualang-para';
  p.textContent = translatedParas.join('\n\n');
  card.appendChild(p);
}
