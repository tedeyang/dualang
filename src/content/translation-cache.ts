import { TRANSLATION_CACHE_MAX, TRANSLATION_CACHE_TTL_MS } from './constants';

export type CachedVariant = {
  translated: string;
  original: string;
  model?: string;
  baseUrl?: string;
};

type CachedBucket = { variants: CachedVariant[]; ts: number };

const VARIANTS_PER_ID = 5;

/**
 * 按 contentId 分桶、桶内多 variant 的翻译缓存。
 *
 * X 的虚拟 DOM 会让同一推文在截断态 / 完整态 / 编辑态之间反复切换，单 slot
 * (contentId → 单 variant) 的设计会触发"长度差异 → 作废 → 重翻 → 又作废"
 * 的死循环。改成 contentId → variants[]，按 original 文本精确命中，永远
 * 不主动 invalidate；新文本翻完追加 variant。
 *
 * 容量两层：
 *   - 桶内 VARIANTS_PER_ID（默认 5）：同一推文 5 种文本变体内 LRU 弹最旧
 *   - 全局 TRANSLATION_CACHE_MAX：contentId 数量上限（按插入序弹最旧 contentId）
 *   - TTL：bucket.ts 超 TRANSLATION_CACHE_TTL_MS 整桶失效
 */
export function createTranslationCache(opts?: {
  maxBuckets?: number;
  variantsPerId?: number;
  ttlMs?: number;
}) {
  const maxBuckets = opts?.maxBuckets ?? TRANSLATION_CACHE_MAX;
  const variantsPerId = opts?.variantsPerId ?? VARIANTS_PER_ID;
  const ttlMs = opts?.ttlMs ?? TRANSLATION_CACHE_TTL_MS;
  const map = new Map<string, CachedBucket>();

  function freshBucket(contentId: string): CachedBucket | undefined {
    const bucket = map.get(contentId);
    if (!bucket) return undefined;
    if (Date.now() - bucket.ts > ttlMs) {
      map.delete(contentId);
      return undefined;
    }
    return bucket;
  }

  return {
    /** 按当前文本精确匹配 variant；未命中返回 undefined（不作 stale 处理）。 */
    match(contentId: string, currentText: string): CachedVariant | undefined {
      const bucket = freshBucket(contentId);
      if (!bucket) return undefined;
      return bucket.variants.find((v) => v.original === currentText);
    },
    /** 取最近写入的 variant —— 用于 mode 切换 / toggle 还原（无 currentText 上下文）。 */
    any(contentId: string): CachedVariant | undefined {
      const bucket = freshBucket(contentId);
      if (!bucket) return undefined;
      return bucket.variants[bucket.variants.length - 1];
    },
    /** 同 original 的 variant 替换，否则追加；超 variantsPerId 弹最旧。 */
    set(contentId: string, value: CachedVariant): void {
      let bucket = map.get(contentId);
      if (!bucket) {
        bucket = { variants: [], ts: Date.now() };
        map.set(contentId, bucket);
      }
      bucket.ts = Date.now();
      const idx = bucket.variants.findIndex((v) => v.original === value.original);
      if (idx >= 0) bucket.variants[idx] = value;
      else {
        bucket.variants.push(value);
        if (bucket.variants.length > variantsPerId) bucket.variants.shift();
      }
      if (map.size > maxBuckets) {
        const firstKey = map.keys().next().value;
        if (firstKey !== undefined) map.delete(firstKey);
      }
    },
    delete(contentId: string): void { map.delete(contentId); },
    /** 仅供测试。 */
    _size(): number { return map.size; },
    _bucket(contentId: string): CachedBucket | undefined { return map.get(contentId); },
  };
}

export type TranslationCache = ReturnType<typeof createTranslationCache>;
