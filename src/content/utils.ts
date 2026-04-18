export function shouldSkipContent(text: string): boolean {
  const stripped = text.replace(/https?:\/\/\S+/g, '').replace(/\s/g, '');
  if (stripped.length < 6) return true;
  return !/[\p{L}\p{N}]/u.test(stripped);
}

export function isAlreadyTargetLanguage(text: string, lang: string): boolean {
  const clean = text.replace(/\s/g, '');
  if (clean.length === 0) return true;

  if (lang === 'zh-CN' || lang === 'zh-TW') {
    if (/[\u3040-\u30ff]/.test(clean)) return false;
    const cjk = (clean.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
    return cjk / clean.length > 0.4;
  }
  if (lang === 'ja') {
    const kana = (clean.match(/[\u3040-\u30ff]/g) || []).length;
    return kana / clean.length > 0.15;
  }
  if (lang === 'ko') {
    const hangul = (clean.match(/[\uac00-\ud7af]/g) || []).length;
    return hangul / clean.length > 0.3;
  }
  if (lang === 'en') {
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(clean)) return false;
    const latin = (clean.match(/[a-zA-Z]/g) || []).length;
    return latin / clean.length > 0.6;
  }
  return false;
}

/**
 * 从元素中提取一个"内容 ID"，用于在 DOM 被虚拟回收 / SPA 导航 / 重入时
 * 命中已翻译过的同一逻辑内容。策略按优先级顺序尝试，首个命中返回。
 * 无策略匹配时返回 null — 调用方应跳过按 ID 的缓存操作（L2 的文本哈希缓存不受影响）。
 *
 * 注意：只返回最"外层/自身"级别的 ID。嵌套内容（如引用推文里嵌套 article）调用时
 * 传入内层 el 即可得到内层自己的 ID，因为我们按文档顺序取 el 子树内第一个匹配的 anchor。
 */
type IdStrategy = (el: Element) => string | null;

function matchAnchorHref(el: Element, re: RegExp): string | null {
  const anchors = el.querySelectorAll('a[href]');
  for (const a of anchors) {
    const href = a.getAttribute('href') || '';
    const m = href.match(re);
    if (m && m[1]) return m[1];
  }
  return null;
}

const ID_STRATEGIES: IdStrategy[] = [
  // X / Twitter: /<user>/status/<numeric id>
  (el) => matchAnchorHref(el, /\/status\/(\d+)/),
  // Mastodon: /@user/<numeric id> 或 /users/<user>/statuses/<id>
  (el) => matchAnchorHref(el, /\/statuses\/(\d+)/),
  // Reddit: /r/<sub>/comments/<post_id>/
  (el) => matchAnchorHref(el, /\/comments\/([a-z0-9]{5,})/i),
  // Hacker News / Lobste.rs / Lemmy: /item?id=<id>
  (el) => matchAnchorHref(el, /\/item\?id=(\d+)/),
  // YouTube: ?v=<11 字符 id>
  (el) => matchAnchorHref(el, /[?&]v=([A-Za-z0-9_-]{11})/),
  // Bluesky: /profile/<handle>/post/<id>
  (el) => matchAnchorHref(el, /\/post\/([A-Za-z0-9]+)/),
  // 通用 data-* 属性：Medium / Substack / Ghost 等博客平台常见
  (el) => {
    const d = (el as HTMLElement).dataset;
    return d?.postId || d?.commentId || d?.messageId || d?.entryId || d?.threadId || null;
  },
  // 回退：元素自身 id 属性（mock 测试页 / 明确指定 id 的站点）
  (el) => el.id || null,
];

export function getContentId(el: Element): string | null {
  for (const strat of ID_STRATEGIES) {
    const id = strat(el);
    if (id) return id;
  }
  return null;
}

// 向后兼容别名 — 外部代码中旧的 getTweetId 引用可继续工作，新代码一律用 getContentId
export const getTweetId = getContentId;

/**
 * 判断译文的行数/段落数相对原文是否异常少，提示可能被截断/合并/丢失。
 *
 * 字符数比较用"可翻译字符数"（剔除 URL / @mention / #hashtag，它们不参与翻译
 * 也不贡献译文长度）。否则一条 "See https://long/url.com #news by @user" 的推文
 * 原文 80 字，去掉 URL 后只有 15 字，Chinese 译文自然只有 10 字左右 — 按原长度
 * 算会误判为"压缩过度"。
 *
 * 命中任一条件即视为可疑：
 *   - 字符数急剧缩减：译文字符 × 7 < 可翻译原文字符（压缩到 ~14% 以下）
 *   - 行坍缩：原文 ≥ 3 行而译文行数不到一半
 *   - 段落严重合并：原文 ≥ 3 段而译文只有 1 段
 *
 * 门槛先过滤掉短推文（可翻译字符 < 150）避免误伤"两段短句合并成一行"这类合法情况。
 */
export function hasSuspiciousLineMismatch(original: string, translated: string): boolean {
  if (!original || !translated) return false;
  const origTranslatable = translatableCharCount(original);
  if (origTranslatable < 150) return false;

  // 字符级急剧缩减（按可翻译字符）
  if (translated.length * 7 < origTranslatable) return true;

  const origLines = countSignificantLines(original);
  const transLines = countSignificantLines(translated);
  if (origLines >= 3 && transLines * 2 < origLines) return true;

  const origParas = countParagraphs(original);
  const transParas = countParagraphs(translated);
  if (origParas >= 3 && transParas === 1) return true;

  return false;
}

/**
 * 译文段落救援：若译文是单段但原文有多段（≥3），按中英文句末标点拆出句子，
 * 再按目标段数均匀分组。适用于模型忽略 "保留 \\n\\n 段落分隔" 指令后的兜底。
 * 若句数不足以拆成目标段数，返回原文不变（不敢强拆）。
 */
export function rebuildParagraphs(translated: string, targetParaCount: number): string[] {
  if (targetParaCount <= 1) return [translated];
  // 已含段落分隔不动手
  if (/\n\s*\n/.test(translated)) {
    return translated.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  }
  // 按中英文句末标点拆句（保留标点）
  const sentences = translated
    .split(/(?<=[。！？.!?])\s*/u)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length < targetParaCount) return [translated];

  const perPara = Math.ceil(sentences.length / targetParaCount);
  const paras: string[] = [];
  for (let i = 0; i < sentences.length; i += perPara) {
    paras.push(sentences.slice(i, i + perPara).join(''));
  }
  return paras.filter(Boolean);
}

/**
 * "可翻译字符数" = 去掉 URL / @mention / #hashtag 后的字符数。
 * 这些 token 通常在译文里以原文保留或直接省略，不应计入原文-译文长度比较。
 */
function translatableCharCount(s: string): number {
  return stripNonTranslatable(s).length;
}

function stripNonTranslatable(s: string): string {
  return s
    .replace(/https?:\/\/\S+/g, '')
    .replace(/@[A-Za-z0-9_]+/g, '')
    .replace(/#[\p{L}\p{N}_]+/gu, '');
}

/**
 * 判断译文是否未命中目标语言。
 * 典型失败：用户要中文翻译，模型却返回英文（可能复读原文或小改动）。
 * 仅检查 CJK 系列目标语言（zh / ja / ko），其他目标（en / fr / ...）不判。
 *
 * 规则：剥离 URL/@/#、拉丁标点和数字后，计算 CJK 字符占比。
 * 若 < 30% 视为"输出语言错误"。忽略 < 8 字符的译文（短文本信号不足）。
 */
export function isWrongLanguage(translated: string, targetLang: string): boolean {
  if (!translated) return false;
  const lang = String(targetLang || '').toLowerCase();
  // 目标语言使用 CJK 字符集时才做此检查
  const isCjkTarget = lang.startsWith('zh') || lang === 'ja' || lang === 'ko';
  if (!isCjkTarget) return false;

  const stripped = stripNonTranslatable(translated)
    .replace(/[\s\p{P}\p{N}]/gu, '');  // 去掉空白 / 标点 / 数字
  if (stripped.length < 8) return false;

  const cjkMatches = stripped.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\u3400-\u4dbf\uf900-\ufaff]/gu);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  return cjkCount / stripped.length < 0.3;
}

function countSignificantLines(s: string): number {
  return s.split('\n').filter(l => l.trim().length > 0).length;
}

function countParagraphs(s: string): number {
  return s.split(/\n\s*\n/).filter(p => p.trim().length > 0).length;
}

export function extractText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('.dualang-translation, .dualang-btn, .dualang-status').forEach(n => n.remove());
  const raw = ((clone as HTMLElement).innerText || clone.textContent || '').trim();
  return raw.replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 把 tweetText 元素按段落边界切成 N 个 DocumentFragment，保留原 HTML
 * （`<a>` / `<img alt>` / `<span>` 等），供"段落对照"模式用来克隆原文段落。
 *
 * 段落分隔识别两种形态（X.com 实际见到的混合）：
 *   1. 文本节点里出现 `\n\n`（最常见，pre-wrap 推文）
 *   2. 连续的 `<br><br>`（少数富文本推文）
 *
 * 纯空白段（去 trim 后 length=0）会被过滤。返回数组长度即段落数。
 */
export function splitParagraphsByDom(el: Element): DocumentFragment[] {
  const doc = el.ownerDocument || document;
  const groups: Node[][] = [[]];
  const nodes = Array.from(el.childNodes);
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      const parts = text.split(/\n\s*\n/);
      for (let p = 0; p < parts.length; p++) {
        if (parts[p].length > 0) {
          groups[groups.length - 1].push(doc.createTextNode(parts[p]));
        }
        if (p < parts.length - 1) groups.push([]);
      }
    } else if ((node as Element).tagName === 'BR') {
      // 连续 <br><br> 视为段落分隔；单个 <br> 当作行内换行保留
      const next = nodes[i + 1];
      if (next && (next as Element).tagName === 'BR') {
        groups.push([]);
        i++;  // 跳过第二个 <br>
      } else {
        groups[groups.length - 1].push(node.cloneNode(true));
      }
    } else {
      groups[groups.length - 1].push(node.cloneNode(true));
    }
  }
  return groups
    .filter((group) => group.some((n) => (n.textContent || '').trim().length > 0))
    .map((group) => {
      const f = doc.createDocumentFragment();
      group.forEach((n) => f.appendChild(n));
      return f;
    });
}
