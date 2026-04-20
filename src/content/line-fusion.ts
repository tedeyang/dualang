export type LineAlignment = {
  lines: string[];
  confident: boolean;
};

export function splitNonEmptyLines(text: string): string[] {
  return String(text || '')
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 按句末标点切分；CJK 全角标点直接切，西文标点仅在前导词 >= 3 字时切，
 * 避免 "Dr. Smith" / "Mr. Brown" / "U.S." 这类缩写被错拆。
 */
function splitSentences(text: string): string[] {
  return String(text || '')
    .split(/(?<=[。！？])\s*|(?<=\b[A-Za-z][A-Za-z]{2,}[.!?])\s+(?=[A-Z\u4e00-\u9fff])/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 把模型译文对齐到原文的行数。返回的 confident 决定是否进入 line-fusion 渲染：
 *  - 行数一致 → 直接对齐（confident）
 *  - 译文一行、原文多行 → 按句末标点重分；只有每一组都非空才 confident
 *  - 行数不一致（不超过 2x） → 当前做法是强制合并或填空，但都属于"猜" —
 *    返回 lines 但 confident=false，让 renderTranslation 回退到 bilingual/append 正常渲染
 */
export function alignTranslatedLines(originalLines: string[], translatedText: string): LineAlignment {
  const orig = originalLines.map((s) => s.trim()).filter(Boolean);
  const trans = splitNonEmptyLines(translatedText);
  if (orig.length === 0) return { lines: trans, confident: false };

  if (trans.length === orig.length) {
    return { lines: trans, confident: true };
  }

  if (trans.length === 1 && orig.length > 1) {
    const sentences = splitSentences(translatedText);
    if (sentences.length < orig.length) {
      return { lines: trans, confident: false };
    }
    const perGroup = Math.ceil(sentences.length / orig.length);
    const grouped: string[] = [];
    for (let i = 0; i < orig.length; i++) {
      const chunk = sentences.slice(i * perGroup, (i + 1) * perGroup).join(' ').trim();
      grouped.push(chunk);
    }
    // 只有每个 slot 都落到非空内容才算 confident —— 否则用户看到的是
    // 半真半假的行对齐（有些 pair 只剩分隔线）
    const allFilled = grouped.length === orig.length && grouped.every(Boolean);
    return { lines: grouped, confident: allFilled };
  }

  // 行数不匹配：不做强行合并 / 填空，交给上游回退渲染
  return { lines: trans, confident: false };
}
