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
  // Grok 摘要卡（X.com /i/trending/<id>）：卡片没 testid、没链接，用标题哈希作为 ID。
  // 标题是卡片第一个子 div 的文本，对同一 trending 话题稳定；换话题会变。
  (el) => {
    if (!(el instanceof Element) || !el.hasAttribute?.('data-dualang-grok')) return null;
    const title = (el.children[0]?.textContent || '').trim();
    return title ? `grok:${title}` : null;
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

  // 长文（>5000 字符）跳过行数 / 段落坍缩检查：
  //   - 英中翻译中行数比例天然不同（英文列表/代码/项目符号行数多，中文合并进段落）
  //   - 长文已走分段翻译路径（requestTranslationChunked），段数由客户端 join 控制，
  //     不会被模型压缩
  //   - 这个启发式主要针对短推文被模型压缩成 "翻译:" 一行的坏情况
  if (origTranslatable >= 5000) return false;

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
  // 直接用原元素的 innerText —— 脱离 DOM 的 clone 下 innerText 会 fallback 到
  // textContent，丢失 CSS block 布局撑出来的换行（X Articles 里 100+ 个 <div>
  // 段落全部粘成一行）。我们注入的 .dualang-translation / .dualang-btn / .dualang-status
  // 都是 tweetTextEl 的兄弟节点（见 insertBefore 调用点），不在 tweetTextEl 内部，
  // 所以直接读 innerText 不会抓到我们自己的 UI 文字。
  // 另外：X Articles 的段落边界在 innerText 里可能只有单个 \n（tight layout）而非 \n\n，
  // 统一把 2+ 连续 \n 归一为 \n\n，保留单个 \n 作为行内换行供下游按需拆段。
  const raw = ((el as HTMLElement).innerText || el.textContent || '').trim();
  return raw.replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// 按段落切分 extractText 的输出。X Articles 在 innerText 里常用单 \n 分隔段落
// （CSS tight layout），普通推文用 \n\n。两种形态统一对待：优先 \n\n，没有就降级 \n。
// 返回去空白后的非空段落数组。
export function splitIntoParagraphs(text: string): string[] {
  const hasDoubleNL = /\n\s*\n/.test(text);
  const parts = hasDoubleNL
    ? text.split(/\n\s*\n/)
    : text.split(/\n/);
  return parts.map((p) => p.trim()).filter(Boolean);
}

// 按 DOM block-level 结构提取段落，专为长文（X Articles）设计。
// 遍历每个 leaf block（自身是 block 且内部没有更深的 block 子元素）取 textContent，
// 合并为 "\n\n" 分隔的段落串。对 innerText 的 CSS tight-layout（全 \n）或
// margin-separated（全 \n\n）都给出一致的按视觉段落数。
const BLOCK_TAGS = new Set([
  'DIV', 'P', 'SECTION', 'ARTICLE', 'MAIN', 'ASIDE',
  'LI', 'UL', 'OL', 'DL', 'DD', 'DT',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'PRE', 'FIGURE', 'TABLE', 'TR',
]);

export interface AnchoredBlock {
  el: Element;        // 原 DOM 节点，slot 会插到它 afterend
  kind: 'text' | 'img-alt';
  text: string;       // 要送翻译的文本（img-alt 就是 alt 字符串）
}

export function extractAnchoredBlocks(el: Element): AnchoredBlock[] {
  const blocks: AnchoredBlock[] = [];
  function visit(node: Element) {
    const blockChildren = Array.from(node.children).filter((c) => BLOCK_TAGS.has(c.tagName));
    if (blockChildren.length === 0) {
      // 叶子 block：优先识别图片
      // img[alt] CSS selector matches presence of attr; filter rejects alt=""
      const imgs = Array.from(node.querySelectorAll('img[alt]'))
        .map((img) => (img.getAttribute('alt') || '').trim())
        .filter((alt) => alt.length > 0);
      if (imgs.length > 0) {
        blocks.push({ el: node, kind: 'img-alt', text: imgs.join(' ') });
        return;
      }
      const t = (node.textContent || '').trim();
      if (t) blocks.push({ el: node, kind: 'text', text: t });
      return;
    }
    for (const c of blockChildren) visit(c);
  }
  visit(el);
  return blocks;
}

// 保留旧签名以免其他调用方断裂
export function extractParagraphsByBlock(el: Element): string[] {
  return extractAnchoredBlocks(el).map((b) => b.text);
}

/**
 * 把 tweetText 元素按段落边界切成 N 个 DocumentFragment，保留原 HTML
 * （`<a>` / `<img alt>` / `<span>` 等），供"段落对照"模式用来克隆原文段落。
 *
 * 段落分隔识别两种形态（X.com 实际结构都见过）：
 *   1. 任意深度的文本节点里出现 `\n\n`（X.com 主列表常把整段推文包进一个 `<span>`，
 *      多段落通过 `\n\n` 分隔，**不是** 顶层兄弟节点）
 *   2. 连续的 `<br><br>`（少数富文本推文）
 *
 * 实现：先克隆整棵子树，把所有 `<br>` 替换成 "\n" 文本节点，再 `normalize()` 把相邻
 * 文本合并成单节点，这样 BR-based 和 \n\n-based 两种形态都归一到"文本节点里找 \n\n"。
 * 然后用 TreeWalker 扫所有 text node 收集 `\n\n` 的 (node, offset) 位置，用这些位置
 * 作为 Range 边界调 `Range.cloneContents()` 提取每段的 fragment —— 跨层级、保留 HTML。
 *
 * 纯空白段（trim 后 length=0）会被过滤。返回数组长度即段落数。
 */
export function splitParagraphsByDom(el: Element): DocumentFragment[] {
  const doc = el.ownerDocument || document;

  // 克隆子树后预处理：<br> → "\n" 文本节点 + normalize() 合并相邻文本节点。
  // 必须操作 clone，避免污染原 DOM。
  const clone = el.cloneNode(true) as Element;
  const brs = Array.from(clone.querySelectorAll('br'));
  for (const br of brs) {
    br.parentNode?.replaceChild(doc.createTextNode('\n'), br);
  }
  (clone as Element & { normalize(): void }).normalize();

  // 收集所有 text node 里 `\n\n` 的位置
  type Break = { node: Text; start: number; end: number };
  const breaks: Break[] = [];
  const walker = doc.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  let n: Node | null = walker.nextNode();
  while (n) {
    const text = (n as Text).data;
    const re = /\n\s*\n/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      breaks.push({ node: n as Text, start: m.index, end: m.index + m[0].length });
    }
    n = walker.nextNode();
  }

  const result: DocumentFragment[] = [];
  const pushRange = (startNode: Node, startOffset: number, endNode: Node, endOffset: number) => {
    const r = doc.createRange();
    r.setStart(startNode, startOffset);
    r.setEnd(endNode, endOffset);
    const frag = r.cloneContents();
    if ((frag.textContent || '').trim().length > 0) result.push(frag);
  };

  if (breaks.length === 0) {
    // 没有段落分隔符：整段作为一个 fragment
    const r = doc.createRange();
    r.selectNodeContents(clone);
    const frag = r.cloneContents();
    if ((frag.textContent || '').trim().length > 0) result.push(frag);
    return result;
  }

  // 第一段：clone 起点 → 第一个 break 的开始
  pushRange(clone, 0, breaks[0].node, breaks[0].start);
  // 中间各段：上一 break 结束 → 下一 break 开始
  for (let i = 0; i < breaks.length - 1; i++) {
    pushRange(breaks[i].node, breaks[i].end, breaks[i + 1].node, breaks[i + 1].start);
  }
  // 最后一段：最后一个 break 结束 → clone 终点
  const last = breaks[breaks.length - 1];
  pushRange(last.node, last.end, clone, clone.childNodes.length);

  return result;
}
