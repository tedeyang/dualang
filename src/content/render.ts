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
          trans.appendChild(linkifyText(translatedParas[i]));
          pair.appendChild(trans);
        }
        card.appendChild(pair);
      }
      // 译文多出的尾段：按一段译文块追加
      for (let i = originalParas.length; i < translatedParas.length; i++) {
        const trans = document.createElement('div');
        trans.className = 'dualang-para';
        trans.appendChild(linkifyText(translatedParas[i]));
        card.appendChild(trans);
      }
    }
  } else if (!renderedByFusion) {
    // append / bilingual / translation-only 共享同一套 card 结构 —— 只追加译文。
    // bilingual 不再克隆原文到 card 内：
    //   - 过去方案（隐藏原生 tweetText + 克隆 .dualang-original-html）会让 card 高度
    //     比 append 多 5-10px（clone 的 line-height 和 X 原生不一致 + 额外的
    //     border-bottom/padding-bottom 分隔间距），切换 append↔bilingual 时页面跳动
    //   - 新方案：保持原生 tweetText 可见，仅通过 CSS 把它的 color 改暗（见 styles.css
    //     "对照模式下的强调权重"段），card 结构和 append 完全一致 → 切换零跳动
    // 三种模式的区别只在 CSS：
    //   - append: tweetText 原生色 + card.dualang-para 暗色
    //   - bilingual: tweetText 改暗色 + card.dualang-para 原生色
    //   - translation-only: tweetText display:none + card.dualang-para 原生色
    if (displayMode === 'bilingual') card.classList.add('dualang-bilingual');
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
      orig.appendChild(linkifyText(originalLines[i]));
      pair.appendChild(orig);
    }
    const divider = document.createElement('div');
    divider.className = 'dualang-line-fusion-divider';
    pair.appendChild(divider);

    const trans = document.createElement('div');
    trans.className = 'dualang-line-fusion-trans';
    trans.appendChild(linkifyText(translatedLines[i]));
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
  p.appendChild(linkifyText(translatedParas.join('\n\n')));
  card.appendChild(p);
}

/**
 * 把字符串里的 http(s):// URL 包成可点击的 <a>，其余内容保留为文本节点，整体返回
 * DocumentFragment。用于所有"从字符串构造展示内容"的渲染路径（line-fusion 原文/译文、
 * 译文段落 .dualang-para、inline 段落配对的译文侧），否则 tweetText 里的链接在我们的
 * card 上会被展平为纯文本，无法点击。
 *
 * 只识别显式 http(s):// 协议的完整 URL；#hashtag / @mention 留给用户主动点 X 原生
 * tweetText（append/bilingual 下可见）。
 * 修剪尾部 `.,;!?)\"'…` 避免把句末标点并进 href。
 */
export function linkifyText(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const urlRe = /\bhttps?:\/\/[^\s<>"'`]+/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(text)) !== null) {
    let url = m[0];
    const trailMatch = /[.,;!?)\]>"'…]+$/.exec(url);
    if (trailMatch) url = url.slice(0, url.length - trailMatch[0].length);
    if (!url) continue; // 极端情况：修剪后为空，放弃这个匹配
    if (m.index > lastIdx) {
      frag.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
    }
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = url;
    a.className = 'dualang-link';
    frag.appendChild(a);
    lastIdx = m.index + url.length;
  }
  if (lastIdx < text.length) {
    frag.appendChild(document.createTextNode(text.slice(lastIdx)));
  }
  return frag;
}
