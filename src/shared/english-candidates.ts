/**
 * 英文推文的字典候选词抽取 —— content / background 都会用。
 * 原先放在 content/smart-dict.ts；background 要做本地难度预筛时也需要同一套逻辑，
 * 抽到 shared 层避免两边漂移。
 */

/** 候选词上限 —— 超过后裁剪，避免长推文撑爆 prompt。*/
export const MAX_CANDIDATES = 40;

// 常见高频词不需要字典注释；这是"极保守"的基础停用词 —— background 的
// difficulty.ts 还会在之后做更精细的 Zipf 频率过滤。
const STOPWORDS = new Set([
  'a', 'about', 'after', 'again', 'all', 'also', 'am', 'an', 'and', 'any', 'are',
  'as', 'at', 'back', 'be', 'because', 'been', 'before', 'being', 'between',
  'both', 'but', 'by', 'can', 'could', 'did', 'do', 'does', 'doing', 'done',
  'down', 'during', 'each', 'every', 'few', 'for', 'from', 'further', 'get',
  'got', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself',
  'him', 'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'itself', 'just', 'like', 'make', 'me', 'might', 'more', 'most', 'must', 'my',
  'myself', 'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'one', 'only',
  'or', 'other', 'our', 'ours', 'ourselves', 'out', 'over', 'own', 'said',
  'same', 'say', 'see', 'she', 'should', 'so', 'some', 'such', 'take', 'than',
  'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there',
  'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until',
  'up', 'us', 'use', 'used', 'very', 'want', 'was', 'we', 'were', 'what',
  'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with',
  'would', 'you', 'your', 'yours', 'yourself', 'yourselves',
]);

function sanitizeText(text: string): string {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@[A-Za-z0-9_]+/g, ' ')
    .replace(/#[\w-]+/g, ' ');
}

export function isLikelyEnglishText(text: string): boolean {
  const clean = sanitizeText(text);
  const latin = (clean.match(/[A-Za-z]/g) || []).length;
  const cjk = (clean.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  if (latin < 12) return false;
  if (latin + cjk === 0) return false;
  return latin / (latin + cjk) > 0.75;
}

export function extractDictionaryCandidates(text: string, max = MAX_CANDIDATES): string[] {
  const clean = sanitizeText(text);
  const tokens = clean.match(/[A-Za-z][A-Za-z'-]{1,}/g) || [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tokens) {
    // 丢专有名词 / 缩写 / 句首大写词：首字母大写的 token 绝大多数是名字、品牌、
    // 缩略词（Mitchell / NBA / Cavs / Notion），不是"值得查字典的难词"。
    // 小概率漏放句首的真难词（"Ubiquitous ..."）—— 但推文极少以硬词开头，可以接受。
    if (raw[0] >= 'A' && raw[0] <= 'Z') continue;
    // 丢缩略形式（he's / don't / they're）—— lowercase 之后本来就不是独立的字典词条
    if (raw.includes("'")) continue;
    const t = raw.toLowerCase();
    if (t.length < 3) continue;
    if (STOPWORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}
