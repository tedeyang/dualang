/**
 * 英文单词难度本地预判 —— 插件内对候选词打分，仅把"真难"的发给大模型拿 IPA/gloss。
 *
 * 动机：模型在一长串候选里挑词容易偏向常见词（overlearning），也浪费 token；提前
 * 用 Zipf 频率 + 音节 + 词长 + 领域词表打分，把明显常见的词在背景层过滤掉，
 * prompt 就只带难词候选，模型不再"要不要收"纠结，结果更稳。
 *
 * API shape 参考 `docs/refs/difficulty.ts`；数据层无 wordfreq 依赖 —— 内嵌 ~1500 个
 * COCA/Oxford 高频词作为"伪 Zipf=6.5"桶，未登录词默认 Zipf=2.0（罕见 → 难度高）。
 * 覆盖率对典型英文推文足够；需要更精细分布时可替换为真实频率表。
 */

import { COMMON_EN_WORDS } from './common-en-words';

export type DifficultyLevel = 0 | 1 | 2 | 3 | 4;

export interface DifficultyResult {
  word: string;
  zipf: number;
  freqScore: number;   // 0-1, 越大越难
  syllables: number;
  length: number;
  domainBoost: number; // 0 或 1
  rawScore: number;    // 0-1 综合难度
  level: DifficultyLevel;
}

export interface DifficultyOptions {
  wFreq?: number;
  wSyllable?: number;
  wLength?: number;
  wDomain?: number;
  domainWords?: Set<string>;
}

// ============ 频率映射 ====================================================

/**
 * 词表查表判断常见度。为什么要做屈折回退：
 * 词表只收 lemma（原形），真实文本里 "beats / beating / heading / tried / easier"
 * 这类屈折形式在查表时会 miss → 被误判为"罕见难词"送给模型。
 * 这里做轻量 stem：去掉常见后缀，再查表；命中即复用该 lemma 的 Zipf 分。
 */
function lookupZipf(word: string): number {
  if (COMMON_EN_WORDS.has(word)) return 6.5;
  // 常规复数 / 动词三单 / 形容词比较级 / 进行时 / 过去式 / 副词后缀
  const suffixes = ['s', 'es', 'ed', 'ing', 'er', 'est', 'ly'];
  for (const sfx of suffixes) {
    if (word.length > sfx.length + 2 && word.endsWith(sfx)) {
      const stem = word.slice(0, -sfx.length);
      if (COMMON_EN_WORDS.has(stem)) return 6.5;
      // "making" → "make"（CVCe：加 e 还原）
      if (sfx === 'ing' || sfx === 'ed' || sfx === 'er' || sfx === 'est') {
        if (COMMON_EN_WORDS.has(stem + 'e')) return 6.5;
      }
    }
  }
  // "families → family" / "tried → try" / "easier → easy"
  if (word.endsWith('ies') && word.length > 4) {
    if (COMMON_EN_WORDS.has(word.slice(0, -3) + 'y')) return 6.5;
  }
  if (word.endsWith('ied') && word.length > 4) {
    if (COMMON_EN_WORDS.has(word.slice(0, -3) + 'y')) return 6.5;
  }
  if (word.endsWith('ier') && word.length > 4) {
    if (COMMON_EN_WORDS.has(word.slice(0, -3) + 'y')) return 6.5;
  }
  return 2.0;
}

function zipfToDifficulty(zipf: number): number {
  const Z_MIN = 1;
  const Z_MAX = 7;
  const clamped = Math.min(Math.max(zipf, Z_MIN), Z_MAX);
  return 1 - (clamped - Z_MIN) / (Z_MAX - Z_MIN);
}

// ============ 音节估计 ====================================================

/**
 * 元音分组法估算英文音节；末尾哑 e 扣一。误差 ±1，对难度打分够用。
 * 比 `syllable` npm 包少几 KB 依赖；如有精度需求可换真包。
 */
export function syllableCount(raw: string): number {
  const word = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (word.length === 0) return 0;
  if (word.length <= 3) return 1;

  let count = 0;
  let prevVowel = false;
  for (let i = 0; i < word.length; i++) {
    const isVowel = 'aeiouy'.includes(word[i]);
    if (isVowel && !prevVowel) count++;
    prevVowel = isVowel;
  }
  // 末尾哑 e 修正：
  //   "make" (CVCe)    → 扣一  (2 → 1)
  //   "smile" (VCle)   → 扣一  (2 → 1)  — "le" 前是元音 → 典型 magic-e
  //   "create" (VVCe)  → 不扣（2 → 2）— 倒数第 4 是元音 → 可能有两个连续元音字母构成独立音节
  //   "able" / "table" (Cle)   → 不扣（2 → 2）— "le" 前是辅音 → "le" 本身就是独立音节
  if (word.endsWith('e') && count > 1) {
    const c4 = word[word.length - 4]; // 倒数第 4 字符
    const c4IsVowel = !!c4 && 'aeiouy'.includes(c4);
    const isConsonantPlusLe = word.endsWith('le')
      && word.length > 2
      && !'aeiouy'.includes(word[word.length - 3]);
    if (!c4IsVowel && !isConsonantPlusLe) count--;
  }
  return Math.max(count, 1);
}

function syllableScore(n: number): number {
  const MAX = 5;
  const clamped = Math.min(n, MAX);
  return (clamped - 1) / (MAX - 1);
}

function lengthScore(len: number): number {
  const MIN = 3;
  const MAX = 12;
  const clamped = Math.min(Math.max(len, MIN), MAX);
  return (clamped - MIN) / (MAX - MIN);
}

function scoreToLevel(score: number): DifficultyLevel {
  if (score < 0.2) return 0; // A1-A2
  if (score < 0.4) return 1; // B1
  if (score < 0.6) return 2; // B2
  if (score < 0.8) return 3; // C1
  return 4;                  // C2+
}

// ============ 主分析器 ====================================================

export function analyzeWord(input: string, options: DifficultyOptions = {}): DifficultyResult {
  const {
    wFreq = 0.7,
    wSyllable = 0.15,
    wLength = 0.1,
    wDomain = 0.05,
    domainWords = new Set<string>(),
  } = options;

  const word = input.toLowerCase().trim();
  const zipf = lookupZipf(word);
  const fScore = zipfToDifficulty(zipf);
  const sCount = syllableCount(word);
  const sScore = syllableScore(sCount);
  const lScore = lengthScore(word.length);
  const domainBoost = domainWords.has(word) ? 1 : 0;

  const raw =
    wFreq * fScore + wSyllable * sScore + wLength * lScore + wDomain * domainBoost;
  const weightSum = wFreq + wSyllable + wLength + wDomain;
  const rawScore = Math.min(Math.max(raw / weightSum, 0), 1);

  return {
    word,
    zipf,
    freqScore: fScore,
    syllables: sCount,
    length: word.length,
    domainBoost,
    rawScore,
    level: scoreToLevel(rawScore),
  };
}

// ============ 候选词筛选 ==================================================

export interface FilterOptions extends DifficultyOptions {
  /** rawScore 阈值；0.4 ≈ B1+，0.5 ≈ B2+，0.6 ≈ C1+。默认 0.5 对应"六级及以上"大致观感 */
  threshold?: number;
  /** 最多保留多少个；默认 10 避免 prompt 过长 */
  max?: number;
}

/**
 * 把候选词按难度排序，只保留阈值以上的 top-N。返回按难度降序的数组。
 * 送到大模型时只需关心"选哪几个加字典"，常见词在此已被丢弃。
 */
export function filterHardCandidates(candidates: string[], opts: FilterOptions = {}): string[] {
  const { threshold = 0.5, max = 10, ...analyzeOpts } = opts;
  return candidates
    .map((c) => ({ word: c, result: analyzeWord(c, analyzeOpts) }))
    .filter((x) => x.result.rawScore >= threshold)
    .sort((a, b) => b.result.rawScore - a.result.rawScore)
    .slice(0, max)
    .map((x) => x.word);
}
