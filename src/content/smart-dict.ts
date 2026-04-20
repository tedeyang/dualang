// 候选词抽取 / 英文识别逻辑已上提到 shared/english-candidates.ts（content + background 共用）。
// 这里重新导出保留原来的 import 路径，同时本文件专注 DOM 注入 / 清除 / DictEntry 类型。
export {
  extractDictionaryCandidates,
  isLikelyEnglishText,
  MAX_CANDIDATES,
} from '../shared/english-candidates';

export type DictLevel = 'cet6' | 'ielts' | 'kaoyan';
export type DictEntry = {
  term: string;
  ipa: string;
  gloss: string;
  level?: DictLevel;
};

// 早期版本在定义前缀用"六级/雅思/考研"中文徽章展示 level；实测模型分级不稳（会把 cet4
// 级的常见词也标成"考研"），反而误导读者。保留 level 字段持久化到 data-level 以便未来
// 做悬停提示 / 统计，但渲染层不再展示。

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shouldSkipTextNode(node: Node): boolean {
  const parent = node.parentElement;
  if (!parent) return true;
  // 避免在已注释的词或内部定义 span 上递归注入
  if (parent.closest('.dualang-dict-term')) return true;
  if (parent.closest('.dualang-dict-def')) return true;
  if (parent.closest('a,code,pre,kbd,samp')) return true;
  return false;
}

export function clearDictionaryAnnotations(root: Element): void {
  root.querySelectorAll<HTMLElement>('.dualang-dict-term').forEach((el) => {
    // 结构是 <span.dualang-dict-term>TERM<span.dualang-dict-def>【...】</span></span>
    // 恢复时只取原始词（去掉定义 span）
    const def = el.querySelector('.dualang-dict-def');
    if (def) def.remove();
    const txt = document.createTextNode(el.textContent || '');
    el.replaceWith(txt);
  });
}

export function applyDictionaryAnnotations(root: Element, entries: DictEntry[]): void {
  clearDictionaryAnnotations(root);
  if (!entries || entries.length === 0) return;

  const normalized = entries
    .map((e) => ({
      ...e,
      term: String(e.term || '').trim(),
      ipa: String(e.ipa || '').trim(),
      gloss: String(e.gloss || '').trim(),
    }))
    .filter((e) => e.term && (e.ipa || e.gloss));
  if (normalized.length === 0) return;

  const used = new Set<string>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let cur: Node | null = walker.nextNode();
  while (cur) {
    textNodes.push(cur as Text);
    cur = walker.nextNode();
  }

  for (const node of textNodes) {
    if (!node.nodeValue || !node.nodeValue.trim()) continue;
    if (shouldSkipTextNode(node)) continue;
    let text = node.nodeValue;
    let changed = false;
    const frag = document.createDocumentFragment();

    while (text.length > 0) {
      let bestMatch: { idx: number; len: number; entry: DictEntry; found: string } | null = null;
      for (const entry of normalized) {
        const key = entry.term.toLowerCase();
        if (used.has(key)) continue;
        const re = new RegExp(`\\b${escapeRegExp(entry.term)}\\b`, 'i');
        const m = text.match(re);
        if (!m || m.index === undefined) continue;
        if (!bestMatch || m.index < bestMatch.idx) {
          bestMatch = { idx: m.index, len: m[0].length, entry, found: m[0] };
        }
      }
      if (!bestMatch) {
        frag.appendChild(document.createTextNode(text));
        break;
      }
      if (bestMatch.idx > 0) {
        frag.appendChild(document.createTextNode(text.slice(0, bestMatch.idx)));
      }
      // 真实 DOM 节点而非 ::after 伪元素 —— 定义文本可被选中、复制、朗读。
      // 结构：<span.dualang-dict-term>TERM<span.dualang-dict-def>【释义 /ipa/】</span></span>
      // 顺序：先中文释义（读者注意力焦点），再 IPA（辅助发音）。
      // level 仍存 data-level 以便未来做悬停提示 / 统计，但不再显示在文本里 —— 模型的
      // 分级偶尔不稳（把 beats 标考研），显式标签反而误导，干净展示"释义 + 音标"最实用。
      const term = document.createElement('span');
      term.className = 'dualang-dict-term';
      term.appendChild(document.createTextNode(bestMatch.found));
      const def = document.createElement('span');
      def.className = 'dualang-dict-def';
      if (bestMatch.entry.level) def.dataset.level = bestMatch.entry.level;
      const gloss = bestMatch.entry.gloss.trim();
      const ipa = bestMatch.entry.ipa.trim();
      const body = [gloss, ipa].filter(Boolean).join(' ');
      def.textContent = body ? `【${body}】` : '';
      term.appendChild(def);
      frag.appendChild(term);
      used.add(bestMatch.entry.term.toLowerCase());
      text = text.slice(bestMatch.idx + bestMatch.len);
      changed = true;
    }

    if (changed) node.replaceWith(frag);
  }
}
