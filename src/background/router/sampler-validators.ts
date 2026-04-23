/**
 * 采样器的译文质量校验 —— 纯函数，与 chrome/api.ts 解耦便于单测。
 * 与 docs/decisions/smart-router-design.md §5 的启发式对齐。
 */

const CJK_RE = /[一-鿿]/g;
/** 连续 3 个英文字母 —— 判"英文泄漏"（译文里还大段保留原文） */
const ENGLISH_RUN_RE = /[A-Za-z]{3,}/g;

export function cjkRatio(s: string): number {
  if (!s) return 0;
  const cjkCount = (s.match(CJK_RE) || []).length;
  return cjkCount / s.length;
}

export function hasCJK(s: string): boolean {
  return CJK_RE.test(s);
}

/**
 * 译文中英文片段占比。原文里的 URL / mention / hashtag / 专有名词（CamelCase）
 * 通常应保留；所以判泄漏只看连续 3+ 字母的英文 token 数量是否异常高。
 * 返回 [0,1]：> 0.3 视为泄漏严重。
 */
export function englishLeakRatio(translated: string): number {
  if (!translated) return 0;
  const tokens: string[] = translated.match(ENGLISH_RUN_RE) || [];
  const totalEnglishChars = tokens.reduce((sum, t) => sum + t.length, 0);
  return totalEnglishChars / translated.length;
}

/** 长度比：译文 / 原文。正常中译在 [0.3, 1.5] 区间（CJK 字符密度大）。 */
export function lengthRatio(original: string, translated: string): number {
  if (!original) return 0;
  return translated.length / original.length;
}

export interface QualityVerdict {
  pass: boolean;
  reasons: string[];
  cjkRatio: number;
  englishLeak: number;
  lengthRatio: number;
}

export interface ValidateOptions {
  minCjkRatio?: number;
  maxEnglishLeak?: number;
  lengthRatioMin?: number;
  lengthRatioMax?: number;
}

export function validateTranslation(
  original: string,
  translated: string,
  opts: ValidateOptions = {},
): QualityVerdict {
  const {
    minCjkRatio = 0.3,
    maxEnglishLeak = 0.3,
    lengthRatioMin = 0.15,
    lengthRatioMax = 3.0,
  } = opts;
  const cjk = cjkRatio(translated);
  const leak = englishLeakRatio(translated);
  const lr = lengthRatio(original, translated);
  const reasons: string[] = [];
  if (!translated.trim()) reasons.push('空输出');
  if (cjk < minCjkRatio) reasons.push(`汉字占比 ${(cjk * 100).toFixed(0)}% < ${(minCjkRatio * 100).toFixed(0)}%`);
  if (leak > maxEnglishLeak) reasons.push(`英文残留 ${(leak * 100).toFixed(0)}% > ${(maxEnglishLeak * 100).toFixed(0)}%`);
  if (lr < lengthRatioMin) reasons.push(`长度比 ${lr.toFixed(2)} < ${lengthRatioMin}`);
  if (lr > lengthRatioMax) reasons.push(`长度比 ${lr.toFixed(2)} > ${lengthRatioMax}`);
  return {
    pass: reasons.length === 0,
    reasons,
    cjkRatio: cjk,
    englishLeak: leak,
    lengthRatio: lr,
  };
}

export interface BatchVerdict {
  pass: boolean;
  reasons: string[];
  perItem: QualityVerdict[];
  countMatch: boolean;
}

/** 批量校验：所有条目都走 single validator，任一失败都算整体失败。 */
export function validateBatch(
  originals: string[],
  translations: string[],
  opts?: ValidateOptions,
): BatchVerdict {
  const countMatch = translations.length === originals.length;
  const reasons: string[] = [];
  if (!countMatch) {
    reasons.push(`条数不对：${translations.length}/${originals.length}`);
  }
  const perItem = originals.map((o, i) =>
    validateTranslation(o, translations[i] || '', opts),
  );
  perItem.forEach((v, i) => {
    if (!v.pass) reasons.push(`第 ${i + 1} 条：${v.reasons.join('；')}`);
  });
  return { pass: reasons.length === 0, reasons, perItem, countMatch };
}

/**
 * 快速看模型输出里是否带 reasoning token（<think>...</think> / <｜...｜> 之类）。
 * 实际翻译 content 如果被 wrapper 包住就不能直接用 —— sampler 会记录但不失败，
 * 让路由器把 thinkingMode 画像打成 'forced'。
 */
export function detectThinkingArtifacts(output: string): boolean {
  if (!output) return false;
  return /<think[\s\S]*?<\/think>/i.test(output) || /<\|[^|]+\|>/.test(output);
}
