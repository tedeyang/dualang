import { shouldSkipContent, isAlreadyTargetLanguage, extractText, extractTextWithMedia, getContentId, hasSuspiciousLineMismatch, isWrongLanguage, isVerbatimReturn, rebuildParagraphs, splitParagraphsByDom, splitIntoParagraphs, extractAnchoredBlocks, isLongText, isLongRichElement } from './utils';
import { getModelMeta } from '../shared/model-meta';
import * as bubble from './super-fine-bubble';
import { renderInlineSlots, fillSlot, clearInlineSlots } from './super-fine-render';
import { getState, ensureState } from './article-state';
import { telemetry } from './telemetry';
import { normalizeDisplayMode, type DisplayMode } from './display-mode';
import { requestTranslationChunked } from './long-article-chunked';
import { findAndPrepareGrokCards, GROK_DISCLAIMER_PREFIXES } from './grok-card';
import { ctaTranslateNow, ctaCancel } from '../shared/i18n';
import { renderTranslation } from './render';
import { isLikelyEnglishText, extractDictionaryCandidates, applyDictionaryAnnotations, clearDictionaryAnnotations, type DictEntry } from './smart-dict';
import {
  BATCH_SIZE, SUB_BATCH_SIZE, MAX_CONCURRENT,
  TRANSLATION_CACHE_MAX, TRANSLATION_CACHE_TTL_MS,
  SCHEDULER_URGENT_DELAY_MS, SCHEDULER_IDLE_DELAY_MS, SCHEDULER_MAX_AGGREGATE_MS,
  SHOW_MORE_STABLE_MS,
  REQUEST_TIMEOUT_MS, LONG_CHUNK_TIMEOUT_MS, STREAM_TIMEOUT_MS, SUPER_FINE_TIMEOUT_MS, adaptiveTimeoutMs,
} from './constants';

type TranslateMeta = { model?: string; baseUrl?: string; tokens?: number; fromCache?: boolean };

// 展示模式 DisplayMode 从 display-mode.ts import：
//   append         —— 原文保留，译文附在下方（默认，最轻量）
//   translation-only — 仅显示译文，原文 tweetTextEl 被隐藏
//   inline         —— 段落翻译：原文 HTML 克隆 + 译文逐段交错；tweetTextEl 隐藏
//   bilingual      —— 整体对照：克隆整段原文 HTML + 整段译文；tweetTextEl 隐藏

(async function () {
  'use strict';

  let enabled = true;
  let targetLang = 'zh-CN';
  let autoTranslate = true;
  let displayMode: DisplayMode = 'append';
  let lineFusionEnabled = false;
  let smartDictEnabled = false;
  let enableStreaming = false;

  // Article 级别的状态通过 WeakMap<Element, ArticleState> 管理（见 article-state.ts）
  // TweetArticle 只是 Element 的别名，保留供 JSDoc / 可读性
  type TweetArticle = Element;

  let processedTweets = new WeakSet();
  const pendingQueue: TweetArticle[] = [];
  const pendingQueueSet = new Set<Element>();
  const translatingSet = new Set<Element>();

  // 按内容 ID 缓存翻译结果（不依赖 DOM 引用，虚拟 DOM 回收后可恢复）
  // 同时记录模型信息，以便 scanAndQueue 恢复时也能显示品牌图标
  type TranslationCacheEntry = { translated: string; original: string; model?: string; baseUrl?: string; ts: number };
  /**
   * LRU + TTL 两道淘汰：
   *   - 容量上限：触顶时淘汰最旧插入项（Map 自然保留插入序）
   *   - TTL：get 命中但超龄视为 miss 并删除，长会话里老译文不会永远占位
   * set 本身不会回写 ts；每次 set 都是新鲜的。
   */
  const translationCache = {
    _map: new Map<string, TranslationCacheEntry>(),
    get(key: string): TranslationCacheEntry | undefined {
      const entry = this._map.get(key);
      if (!entry) return undefined;
      if (Date.now() - entry.ts > TRANSLATION_CACHE_TTL_MS) {
        this._map.delete(key);
        return undefined;
      }
      return entry;
    },
    has(key: string): boolean {
      return this.get(key) !== undefined;
    },
    set(key: string, value: Omit<TranslationCacheEntry, 'ts'>) {
      this._map.set(key, { ...value, ts: Date.now() });
      if (this._map.size > TRANSLATION_CACHE_MAX) {
        const firstKey = this._map.keys().next().value!;
        this._map.delete(firstKey);
      }
    },
    delete(key: string) { this._map.delete(key); },
  };
  type DictCacheEntry = { entries: DictEntry[]; ts: number };
  // 与 translationCache 同结构：TTL 过期 + 超出 MAX 时淘汰最旧（Map 迭代顺序即插入顺序）。
  // 之前无上限 —— 长会话滚动会无声地把 Map 撑到数万条。
  const dictCache = {
    _map: new Map<string, DictCacheEntry>(),
    key(contentId: string, originalText: string): string {
      return `${contentId}|${originalText}`;
    },
    get(key: string): DictCacheEntry | undefined {
      const entry = this._map.get(key);
      if (!entry) return undefined;
      if (Date.now() - entry.ts > TRANSLATION_CACHE_TTL_MS) {
        this._map.delete(key);
        return undefined;
      }
      // LRU touch：命中后重新插入，保持最近使用在末尾
      this._map.delete(key);
      this._map.set(key, entry);
      return entry;
    },
    set(key: string, entries: DictEntry[]) {
      if (this._map.has(key)) this._map.delete(key);
      this._map.set(key, { entries, ts: Date.now() });
      if (this._map.size > TRANSLATION_CACHE_MAX) {
        const firstKey = this._map.keys().next().value!;
        this._map.delete(firstKey);
      }
    },
    dropByContentId(contentId: string) {
      const prefix = `${contentId}|`;
      for (const k of this._map.keys()) {
        if (k.startsWith(prefix)) this._map.delete(k);
      }
    },
  };
  let viewportObserver = null;
  let preloadObserver = null;
  let activeRequests = 0;
  const retryCounts = new WeakMap();

  const pendingScanRoots = new Set();
  let scanTimer = null;

  // 埋点短名别名 —— 散落调用点沿用 perfLog/logBiz 命名，保留以避免大规模字符替换
  const perfLog = telemetry.perf.bind(telemetry);
  const logBiz = telemetry.biz.bind(telemetry);

  telemetry.startSummary(
    10_000,
    () => ({
      pendingQueueLength: pendingQueue.length,
      translatingSetSize: translatingSet.size,
    }),
    () => telemetry.get('apiCalls') + telemetry.get('renderCalls')
         + telemetry.get('mutationObserverFires') + telemetry.get('queueTranslationCalls'),
  );

  // ========== 事件驱动调度器 ==========
  // 统一管理 flush 时机，替代散落各处的 scheduleFlush() 调用
  const scheduler = {
    _timer: null as ReturnType<typeof setTimeout> | null,
    _timerCreatedAt: 0,

    /** 请求一次 flush。urgent=true 用于视口内推文（80ms），否则 200ms 聚合 */
    request(urgent = false) {
      if (!enabled || pendingQueue.length === 0 || activeRequests >= MAX_CONCURRENT) return;

      // 队列已满一个子批次 → 立即执行
      if (pendingQueue.length >= SUB_BATCH_SIZE) {
        this._cancel();
        flushQueue();
        return;
      }

      const delay = urgent ? SCHEDULER_URGENT_DELAY_MS : SCHEDULER_IDLE_DELAY_MS;

      if (this._timer) {
        // 聚合窗口硬上限防饿死
        if (performance.now() - this._timerCreatedAt >= SCHEDULER_MAX_AGGREGATE_MS) {
          this._cancel();
          flushQueue();
          return;
        }
        // urgent 请求不重置 timer（已有的 timer 更短或即将到期）
        if (!urgent) {
          clearTimeout(this._timer);
          this._timer = setTimeout(() => { this._cancel(); flushQueue(); }, delay);
        }
        return;
      }

      this._timerCreatedAt = performance.now();
      this._timer = setTimeout(() => { this._cancel(); flushQueue(); }, delay);
    },

    _cancel() {
      if (this._timer) { clearTimeout(this._timer); this._timer = null; }
      this._timerCreatedAt = 0;
    }
  };

  // ========== RAII: withSlot 安全管理并发槽位 ==========
  // 保证 activeRequests 递增/递减始终配对，释放槽位时自动 drain 队列
  function withSlot<T>(fn: () => Promise<T>): Promise<T> {
    activeRequests++;
    bubble.setTranslationActivity(activeRequests);
    return fn().then(
      (result) => {
        activeRequests--;
        bubble.setTranslationActivity(activeRequests);
        scheduler.request();  // 槽位释放，自动尝试 drain
        return result;
      },
      (err) => {
        activeRequests--;
        bubble.setTranslationActivity(activeRequests);
        scheduler.request();
        throw err;
      }
    );
  }

  // ========== 统一的翻译请求入口 ==========
  type ResponseData = {
    translations: string[];
    usage?: { total_tokens?: number };
    model?: string;
    baseUrl?: string;
    fromCache?: boolean;
    dictEntries?: (DictEntry[] | null)[];
  };

  async function requestTranslation(
    texts: string[],
    priority: number,
    skipCache = false,
    strictMode = false,
    extras?: { retranslateBoost?: boolean },
  ): Promise<ResponseData> {
    // 长文（单条 4k+ 字符 + 6+ 段落）自动切段：小模型在整包 20k 字符输入下
    // 会把 N 段输出压成 2 段，切成 5-段一组的独立 sub-batch 各自翻译能保证段落数对齐。
    if (texts.length === 1 && isLongText(texts[0])) {
      return requestTranslationChunked(texts[0], priority, skipCache, strictMode, {
        retranslateBoost: !!extras?.retranslateBoost,
      });
    }
    // Combined call：字典开关开且非 translation-only 时，对每条英文文本请求字典融合。
    // 非英文条目置 false，background 在 prompt 里就不标 "(dict)" —— 模型不会白算字典。
    const englishFlags = smartDictEnabled && displayMode !== 'translation-only'
      ? texts.map((t) => isLikelyEnglishText(t))
      : undefined;
    const response: any = await Promise.race([
      chrome.runtime.sendMessage({
        action: 'translate',
        payload: {
          texts, priority, skipCache, strictMode,
          smartDict: !!englishFlags && englishFlags.some(Boolean),
          englishFlags,
          retranslateBoost: !!extras?.retranslateBoost,
        },
      }),
      new Promise((_, reject) => {
        const totalChars = texts.reduce((a, t) => a + t.length, 0);
        const timeoutMs = adaptiveTimeoutMs(totalChars, REQUEST_TIMEOUT_MS);
        setTimeout(() => reject(new Error(`翻译请求超时 (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs);
      }),
    ]);
    if (!response?.success) {
      const e: any = new Error(response?.error || '翻译失败');
      e.retryable = response?.retryable !== false;
      throw e;
    }
    return response.data;
  }

  // ========== Service Worker Keep-Alive ==========
  let _bgPort: chrome.runtime.Port | null = null;
  function ensureBgPort() {
    if (_bgPort) return;
    try {
      _bgPort = chrome.runtime.connect(undefined, { name: 'keepalive' });
      _bgPort.onDisconnect.addListener(() => {
        _bgPort = null;
        setTimeout(ensureBgPort, 200);
      });
    } catch (_) {
      _bgPort = null;
    }
  }

  // ========== 主题检测 ==========
  // X.com 黑/白主题通过 body 背景亮度区分。检测结果写到 <html data-dualang-theme>，
  // CSS 变量在该属性下自动切换到亮色方案。
  function applyTheme() {
    const bg = window.getComputedStyle(document.body).backgroundColor;
    const m = bg.match(/\d+/g);
    if (!m) return;
    const [r, g, b] = m.map(Number);
    const luminance = r * 0.299 + g * 0.587 + b * 0.114;
    const theme = luminance > 128 ? 'light' : 'dark';
    document.documentElement.dataset.dualangTheme = theme;
  }

  function watchTheme() {
    applyTheme();
    // X.com 切换主题时会更改 body 的 style（background-color），观察 style 属性变化即可。
    new MutationObserver(applyTheme).observe(document.body, { attributes: true, attributeFilter: ['style', 'class'] });
    // 兼容：部分情况下 html 上的 class 变化先于 body style，也一并观察。
    new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
  }

  // ========== 初始化 ==========
  async function init() {
    const t0 = performance.now();
    const settings = await chrome.storage.sync.get({
      enabled: true,
      targetLang: 'zh-CN',
      autoTranslate: true,
      displayMode: null,  // null 哨兵：未设时根据老 bilingualMode 迁移
      bilingualMode: false,
      lineFusionEnabled: false,
      smartDictEnabled: false,
      enableStreaming: false,
    });
    enabled         = settings.enabled;
    targetLang      = settings.targetLang   || 'zh-CN';
    autoTranslate   = settings.autoTranslate !== false;
    // 迁移：老用户 displayMode 未设，根据 bilingualMode 推导；bilingualMode=true → 'inline'（升级到段落对照）
    displayMode     = normalizeDisplayMode(settings.displayMode, settings.bilingualMode);
    lineFusionEnabled = !!settings.lineFusionEnabled;
    smartDictEnabled = !!settings.smartDictEnabled;
    enableStreaming  = !!settings.enableStreaming;
    perfLog('init', {
      enabled, targetLang, autoTranslate, displayMode, lineFusionEnabled, smartDictEnabled,
      initCostMs: (performance.now() - t0).toFixed(2)
    });
    ensureBgPort();
    watchTheme();
    bubble.initBubble({
      onSuperFineTrigger: (article: Element) => translateArticleSuperFine(article),
      onSuperFineCancel: (article: Element) => {
        const port = getState(article)?.superFinePort;
        try { port?.disconnect(); } catch (_) {}
      },
    });
    setupIntersectionObservers();
    observeMutations();
    setTimeout(() => {
      const t1 = performance.now();
      scanAndQueue(document.body);
      perfLog('firstScan', { scanCostMs: (performance.now() - t1).toFixed(2) });
      if (autoTranslate) scheduler.request();
    }, 150);
  }

  // ========== 开关 & 设置变更监听 ==========

  /**
   * 关闭翻译时：清理所有已注入的 UI（译文卡、状态点、手动按钮、CSS mode 属性），
   * 停清待处理队列和 in-flight 追踪集合，让原文完整恢复。
   * 不清 translationCache —— 再次开启时可秒回显已翻译的内容。
   */
  function disableAndReset(): void {
    // 清 UI
    for (const el of Array.from(document.querySelectorAll('.dualang-translation'))) el.remove();
    for (const el of Array.from(document.querySelectorAll('.dualang-status'))) el.remove();
    for (const el of Array.from(document.querySelectorAll('.dualang-btn'))) el.remove();
    for (const el of Array.from(document.querySelectorAll('[data-dualang-mode]'))) {
      el.removeAttribute('data-dualang-mode');
    }
    for (const el of Array.from(document.querySelectorAll('[data-dualang-line-fusion]'))) {
      el.removeAttribute('data-dualang-line-fusion');
    }
    for (const el of Array.from(document.querySelectorAll('.dualang-dict-term'))) {
      const term = el as HTMLElement;
      term.replaceWith(document.createTextNode(term.textContent || ''));
    }
    // 清队列/跟踪集合
    pendingQueue.length = 0;
    pendingQueueSet.clear();
    translatingSet.clear();
    // processedTweets 是 WeakSet —— 清不掉，保留也无所谓：
    // 重新 enable 时 scanAndQueue 会先 processedTweets.has() 跳过这些 article；
    // 为保证 re-enable 能重新注入 UI，这里无法直接清 WeakSet —— 改由 enable 时
    // 创建新的 WeakSet。但 processedTweets 是 const；改成 let 以便重置。
  }

  /**
   * 开启翻译时：重新扫全页面 + 触发 flush。
   * processedTweets 已在 disableAndReset 被换新（见 applyEnabledChange）。
   */
  function enableAndScan(): void {
    scanAndQueue(document.body);
    if (autoTranslate) scheduler.request();
  }

  function applyEnabledChange(nextEnabled: boolean): void {
    if (enabled === nextEnabled) return;
    enabled = nextEnabled;
    if (!enabled) {
      disableAndReset();
    } else {
      // 换 processedTweets 让 scanAndQueue 重新注入 UI
      processedTweets = new WeakSet();
      enableAndScan();
    }
    logBiz('toggle', { enabled });
  }

  /**
   * displayMode 切换时对已翻译的 article 即时重渲染：
   * 遍历所有挂了 .dualang-translation 的 article → 从 translationCache 按 contentId
   * 取回译文 → 清旧 card → 调 renderTranslationLocal 按新 mode 渲染。
   * 找不到 cache（缓存超 30min TTL 或 translationCache 被 GC）的直接跳过，下次重翻即可。
   */
  function reRenderAllForModeChange(): void {
    const articles = Array.from(document.querySelectorAll('article[data-dualang-mode], article .dualang-translation'));
    // 去重到 article 本身（可能匹配到嵌套 translation 元素）
    const roots = new Set<Element>();
    for (const el of articles) {
      const art = (el as Element).closest?.('article[data-testid="tweet"]') || el;
      if (art instanceof Element) roots.add(art);
    }
    let reRendered = 0;
    for (const article of roots) {
      const contentId = getContentId(article);
      const entry = contentId ? translationCache.get(contentId) : undefined;
      if (!entry) continue;
      const tweetTextEl = findTweetTextEl(article);
      if (!tweetTextEl) continue;
      article.querySelector('.dualang-translation')?.remove();
      article.removeAttribute('data-dualang-mode');
      article.removeAttribute('data-dualang-line-fusion');
      renderTranslationLocal(article, tweetTextEl, entry.translated, entry.original);
      if (smartDictEnabled) {
        void maybeApplySmartDictionary(article, tweetTextEl, entry.original, contentId || undefined);
      } else {
        clearDictWithBaseline(article, tweetTextEl);
      }
      reRendered++;
    }
    logBiz('rerender.onModeChange', { articles: roots.size, reRendered, mode: displayMode });
  }

  /**
   * 根据当前 displayMode 决定字典 span 要注入到哪些 DOM 元素。
   *   - append:          tweetTextEl 可见 → 直接注入
   *   - translation-only: 原文被隐藏，用户看不到英文原词 → 不注字典
   *   - inline / bilingual / lineFusion: tweetTextEl 被 CSS 隐藏，用户看到的是 card 里
   *     的 `.dualang-original-html` 克隆块 → 注入到克隆才可见
   * 返回空数组表示该 mode 不展示字典。
   */
  function dictTargetEls(article: Element, fallback: Element): Element[] {
    if (displayMode === 'translation-only') return [];
    // append / bilingual 都直接注入到原生 tweetText（bilingual 现在不克隆原文，
    // 仅靠 CSS 把 tweetText 变暗 —— 见 styles.css，高度稳定不跳动）。
    if (displayMode === 'append' || displayMode === 'bilingual') return [fallback];
    // inline 按段逐个克隆块注入；card 尚未渲染时退回到 fallback（稀有边界）
    const clones = Array.from(article.querySelectorAll<HTMLElement>(
      '.dualang-translation .dualang-original-html'
    ));
    return clones.length > 0 ? clones : [fallback];
  }

  /**
   * 给字典操作包一层基线同步：每次 apply/clear 后把 ensureState(article).lastText
   * 更新为当前 tweetText 文本。否则下一轮 MutationObserver 比较 currentText vs lastText
   * 时会看到字典 span 带来的 `【ipa gloss】` 差异，误判为 show-more 触发重翻循环。
   *
   * 同时在 apply 时先清掉所有候选位置（tweetText + 所有克隆块）的残留 span ——
   * mode 切换后旧位置可能有遗留。
   */
  function applyDictWithBaseline(article: Element, fallback: Element, entries: DictEntry[]): void {
    // 清残留：旧 mode 下打过字典 → 切到新 mode → 老位置的 span 得先扫干净
    clearDictionaryAnnotations(fallback);
    article.querySelectorAll<HTMLElement>('.dualang-translation .dualang-original-html')
      .forEach((el) => clearDictionaryAnnotations(el));
    article.querySelectorAll<HTMLElement>('.dualang-line-fusion-orig')
      .forEach((el) => clearDictionaryAnnotations(el));
    // 按当前 mode 决定目标，注入
    const targets = dictTargetEls(article, fallback);
    for (const t of targets) applyDictionaryAnnotations(t, entries);
    ensureState(article as TweetArticle).lastText = fallback.textContent || '';
  }

  function clearDictWithBaseline(article: Element, fallback: Element): void {
    // clear 通吃：tweetText + 所有克隆块 + lineFusion 原文行都清一遍（防 mode 切换后残留）
    clearDictionaryAnnotations(fallback);
    article.querySelectorAll<HTMLElement>('.dualang-translation .dualang-original-html')
      .forEach((el) => clearDictionaryAnnotations(el));
    article.querySelectorAll<HTMLElement>('.dualang-line-fusion-orig')
      .forEach((el) => clearDictionaryAnnotations(el));
    ensureState(article as TweetArticle).lastText = fallback.textContent || '';
  }

  function normalizeDictionaryEntries(raw: any): DictEntry[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((e: any) => ({
        term: String(e?.term || '').trim(),
        ipa: String(e?.ipa || '').trim(),
        gloss: String(e?.gloss || '').trim(),
        level: e?.level,
      }))
      .filter((e: DictEntry) => !!e.term && (!!e.ipa || !!e.gloss));
  }

  async function maybeApplySmartDictionary(
    article: Element,
    tweetTextEl: Element,
    originalText: string,
    contentId?: string,
  ): Promise<void> {
    if (!smartDictEnabled || displayMode === 'translation-only') {
      clearDictWithBaseline(article, tweetTextEl);
      return;
    }
    if (!isLikelyEnglishText(originalText)) {
      clearDictWithBaseline(article, tweetTextEl);
      return;
    }

    const stableContentId = contentId || getContentId(article) || '';
    if (!stableContentId) return;
    const key = dictCache.key(stableContentId, originalText);
    const cached = dictCache.get(key);
    if (cached) {
      applyDictWithBaseline(article, tweetTextEl, cached.entries);
      return;
    }

    const candidates = extractDictionaryCandidates(originalText);
    if (candidates.length === 0) {
      logBiz('dict.skip.noCandidates', { textLen: originalText.length });
      return;
    }

    try {
      const resp: any = await chrome.runtime.sendMessage({
        action: 'annotateDictionary',
        payload: {
          text: originalText,
          targetLang,
          candidates,
          contentId: stableContentId,
        },
      });
      if (!resp?.success) {
        logBiz('dict.response.fail', { error: resp?.error }, 'warn');
        return;
      }
      const entries = normalizeDictionaryEntries(resp?.data?.entries);
      logBiz('dict.response.ok', {
        candidates: candidates.length, entries: entries.length,
      });
      if (entries.length === 0) return;
      dictCache.set(key, entries);
      if (contentId) {
        const cur = getContentId(article);
        if (cur && cur !== contentId) return;
      }
      applyDictWithBaseline(article, tweetTextEl, entries);
    } catch (err: any) {
      // 字典失败静默降级，不影响主翻译链路 —— 但记一笔方便排查
      logBiz('dict.request.err', { error: err?.message }, 'warn');
    }
  }

  /**
   * 字典开关 toggle 的快速通路：只在已渲染的 article 上加/移字典 span；
   * 不重建译文 card，也不广播字典 API 请求（只在缓存命中时还原注释）。
   */
  function toggleDictionaryAcrossVisible(on: boolean): void {
    const articles = Array.from(document.querySelectorAll<Element>('article[data-dualang-mode]'));
    for (const article of articles) {
      const tweetTextEl = findTweetTextEl(article);
      if (!tweetTextEl) continue;
      if (!on) {
        clearDictWithBaseline(article, tweetTextEl);
        continue;
      }
      // 仅在 cache 命中时注释；cache miss 下不发 API —— 避免 toggle 瞬时放大 N 条请求。
      // 新 article 会在后续翻译完成时正常走 maybeApplySmartDictionary 的 API 路径。
      const contentId = getContentId(article);
      if (!contentId) continue;
      const entry = translationCache.get(contentId);
      if (!entry) continue;
      if (!isLikelyEnglishText(entry.original)) continue;
      const cached = dictCache.get(dictCache.key(contentId, entry.original));
      if (cached) applyDictWithBaseline(article, tweetTextEl, cached.entries);
    }
  }

  chrome.runtime.onMessage.addListener((request: any, _sender, _sendResponse) => {
    // 右键菜单发来的 toggle（向后兼容）
    if (request.action === 'toggle') applyEnabledChange(!!request.enabled);
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.enabled !== undefined)        applyEnabledChange(changes.enabled.newValue !== false);
    if (changes.targetLang)                   targetLang     = changes.targetLang.newValue    || 'zh-CN';
    if (changes.autoTranslate !== undefined)  autoTranslate  = changes.autoTranslate.newValue !== false;
    if (changes.displayMode !== undefined) {
      const prev = displayMode;
      displayMode = normalizeDisplayMode(changes.displayMode.newValue, false);
      if (prev !== displayMode && enabled) reRenderAllForModeChange();
    }
    if (changes.lineFusionEnabled !== undefined) {
      const prev = lineFusionEnabled;
      lineFusionEnabled = !!changes.lineFusionEnabled.newValue;
      if (prev !== lineFusionEnabled && enabled) reRenderAllForModeChange();
    }
    if (changes.smartDictEnabled !== undefined) {
      const prev = smartDictEnabled;
      smartDictEnabled = !!changes.smartDictEnabled.newValue;
      // 切换字典不需要重建译文 card —— 只在已有的原文里加/移 span 即可。
      // reRenderAllForModeChange 会重渲染每张 card 并对每条缓存的译文重新发字典请求，
      // 一次 toggle 可能同时发几十条 API 请求；span-only 快速通路避开这类放大。
      if (prev !== smartDictEnabled && enabled) toggleDictionaryAcrossVisible(smartDictEnabled);
    }
    if (changes.enableStreaming !== undefined) enableStreaming = !!changes.enableStreaming.newValue;
    // baseUrl / model / apiKey 变化：content 侧不需要做什么；background 的
    // settingsCache 已通过同一 onChanged 失效，下次请求即用新 provider
  });

  // ========== 两层 IntersectionObserver ==========
  function setupIntersectionObservers() {
    if (viewportObserver) return;
    const vh = window.innerHeight || 800;

    viewportObserver = new IntersectionObserver((entries) => {
      if (!enabled) return;
      telemetry.add("viewportObserverFires", entries.length);
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const article = entry.target;
        if (autoTranslate) queueTranslation(article, true);
        else injectTranslateButton(article);
      });
    }, { threshold: 0.05 });

    preloadObserver = new IntersectionObserver((entries) => {
      if (!enabled) return;
      telemetry.add("preloadObserverFires", entries.length);
      entries.forEach((entry) => {
        const article = entry.target;
        if (entry.isIntersecting) {
          const rect = entry.boundingClientRect;
          if (rect.bottom > 0 && rect.top < window.innerHeight) return;
          if (autoTranslate) queueTranslation(article, false);
          return;
        }
        // 离开 preload 区域：若该推文还在 pending 队列中（尚未开始翻译）
        // 且非高优先级（即未被 viewportObserver 升级），从队列摘除以节省配额。
        // 已在 translatingSet 中的 in-flight 请求不取消（成本已付出）。
        if (!pendingQueueSet.has(article)) return;
        const art = article as TweetArticle;
        if (getState(art)?.isHighPriority) return;
        const idx = pendingQueue.indexOf(art);
        if (idx === -1) return;
        pendingQueue.splice(idx, 1);
        pendingQueueSet.delete(article);
        hideStatus(article, true);
        telemetry.inc("preloadCancels");
        perfLog('preloadCancel', {
          contentId: getContentId(article),
          queueLength: pendingQueue.length
        });
      });
    }, { threshold: 0.05, rootMargin: `${vh}px 0px ${vh}px 0px` });
  }

  // ========== 容器抽象：tweet article + Grok 摘要卡 ==========
  // X 的 "Grok AI 摘要卡"（trending 话题 / 热点总结）没有 article / testid / role / aria
  // 可用作锚点；唯一稳定的结构特征是：4 个 child div + 内含 <time> + 最后一个 child 文本
  // 含免责声明。检测后我们给卡片打 data-dualang-grok="true"，body 段落打
  // data-dualang-text="true"，之后就能复用 tweet 的翻译管线（只需把 tweetText 查询
  // 改成同时支持两种标记）。

  function findTweetTextEl(container: Element): Element | null {
    // 三种文本容器都识别：
    //   - [data-testid="tweetText"]              —— 普通推文
    //   - [data-dualang-text="true"]             —— 我们自己打标（Grok 摘要卡的 body）
    //   - [data-testid="twitterArticleRichTextView"] —— X Articles（长文）正文
    //     （不用 twitterArticleReadView：后者会把标题和引擎计数 "143 / 3.4K / 1.7M" 也
    //     抓进文本里混入译文中间）
    return container.querySelector(
      '[data-testid="tweetText"], [data-dualang-text="true"], [data-testid="twitterArticleRichTextView"]'
    );
  }

  // X Articles 识别：文章外壳仍是 article[data-testid="tweet"]，但内部有
  // twitterArticleRichTextView（正文容器）和 twitter-article-title（标题）。
  function isXArticle(article: Element): boolean {
    return !!article.querySelector('[data-testid="twitterArticleRichTextView"]');
  }

  // 超级精翻（流式 + 原 DOM 保留 + 内联 slot 渲染）：
  //   1. 按 DOM block 提取 AnchoredBlock[]（文本块 + img-alt 块）
  //   2. 用 renderInlineSlots 在每个原块后插入 skeleton slot（不动原 DOM）
  //   3. 浮球状态 translating，onCancel 通过 port.disconnect 中止
  //   4. 每 partial 事件：fillSlot(article, index, text)
  //   5. done → 浮球 done、success 图标；error/10min 超时 → 浮球 failed
  async function translateArticleSuperFine(article: Element) {
    let articleId = article.getAttribute('data-dualang-article-id');
    if (!articleId) {
      articleId = 'la-' + Math.random().toString(36).slice(2, 10);
      article.setAttribute('data-dualang-article-id', articleId);
    }
    bubble.bindSuperFineArticle(article);
    // 优先用 twitterArticleRichTextView（X Articles 长文正文），避免 findTweetTextEl
    // 因 CSS 选择器顺序返回同 article 内先出现的短预览 tweetText 元素
    const tweetTextEl =
      article.querySelector('[data-testid="twitterArticleRichTextView"]') ||
      findTweetTextEl(article);
    if (!tweetTextEl) return;
    const blocks = extractAnchoredBlocks(tweetTextEl);
    if (blocks.length === 0) return;

    // 清旧 slot（可能是一次失败后的重翻）
    clearInlineSlots(article);
    renderInlineSlots(article, blocks);

    bubble.setBubbleState(articleId, 'translating', { completed: 0, total: blocks.length });
    updateLongArticleCta(article, 'translating');

    // img-alt 块用 "[图: alt]" 发给模型，便于作为独立段落翻译
    const paragraphs = blocks.map((b) => b.kind === 'img-alt' ? `[图: ${b.text}]` : b.text);
    const apiT0 = performance.now();
    logBiz('translation.superFine.start', { paragraphs: blocks.length });

    let finished = false;
    let port: chrome.runtime.Port | null = null;
    // 心跳式超时：免费 TPM 下 300+ 段长文要跑 10+ 分钟；固定倒计时会把"慢但活着"
    // 的流也杀掉。改成 partial/progress 每来一次就 reset，只有 SUPER_FINE_TIMEOUT_MS
    // 真无声才算卡死。
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const armTimeout = () => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        if (finished) return;
        finished = true;
        try { port?.disconnect(); } catch (_) {}
        bubble.setBubbleState(articleId, 'failed');
        updateLongArticleCta(article, 'failed');
        logBiz('translation.superFine.fail', { error: 'idle-timeout' }, 'warn');
      }, SUPER_FINE_TIMEOUT_MS);
    };
    armTimeout();

    try {
      port = chrome.runtime.connect(undefined, { name: 'super-fine' });
    } catch (err: any) {
      clearTimeout(timeout);
      bubble.setBubbleState(articleId, 'failed');
      updateLongArticleCta(article, 'failed');
      logBiz('translation.superFine.fail', { error: 'connect:' + err.message }, 'warn');
      return;
    }

    ensureState(article).superFinePort = port;
    let metaModel: string | undefined;
    let metaBaseUrl: string | undefined;

    port.onMessage.addListener((msg: any) => {
      if (finished) return;
      if (msg.action === 'meta') {
        metaModel = msg.model;
        metaBaseUrl = msg.baseUrl;
      } else if (msg.action === 'partial') {
        fillSlot(article, msg.index, msg.translated);
        armTimeout();  // 有段落回来就 reset idle 倒计时
      } else if (msg.action === 'progress') {
        bubble.setBubbleState(articleId, 'translating', { completed: msg.completed, total: msg.total });
        armTimeout();
      } else if (msg.action === 'chunkFail') {
        logBiz('translation.superFine.chunkFail', { chunkIndex: msg.chunkIndex, error: msg.error }, 'warn');
      } else if (msg.action === 'done') {
        finished = true;
        clearTimeout(timeout);
        const rtt = performance.now() - apiT0;
        // background 的 handleSuperFineStream 即便部分 chunk 失败也会发 'done'，
        // 只在 completed/total 字段上区分。必须在这里兜住：完成率 < 90% 判失败，
        // 保留 CTA 可见以便用户重试；否则（>=90% 视作可接受的尾部 slot 漏推）走 done。
        const completed = typeof msg.completed === 'number' ? msg.completed : 0;
        const total = typeof msg.total === 'number' ? msg.total : blocks.length;
        const ratio = total > 0 ? completed / total : 1;
        if (ratio < 0.9) {
          bubble.setBubbleState(articleId, 'failed');
          updateLongArticleCta(article, 'failed');
          showFail(article, `精翻部分失败：${completed}/${total} 段完成`);
          logBiz('translation.superFine.partial', {
            paragraphs: blocks.length, completed, total, rttMs: rtt.toFixed(0), model: msg.model || metaModel,
          }, 'warn');
        } else {
          bubble.setBubbleState(articleId, 'done');
          updateLongArticleCta(article, 'done');
          showSuccess(article, { model: msg.model || metaModel, baseUrl: msg.baseUrl || metaBaseUrl, tokens: msg.totalTokens });
          logBiz('translation.superFine.ok', {
            paragraphs: blocks.length, completed, rttMs: rtt.toFixed(0), model: msg.model || metaModel,
          });
        }
        try { port?.disconnect(); } catch (_) {}
      } else if (msg.action === 'error') {
        finished = true;
        clearTimeout(timeout);
        bubble.setBubbleState(articleId, 'failed');
        updateLongArticleCta(article, 'failed');
        logBiz('translation.superFine.fail', { error: msg.error }, 'warn');
        showFail(article, msg.error);
        try { port?.disconnect(); } catch (_) {}
      }
    });

    port.onDisconnect.addListener(() => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      bubble.setBubbleState(articleId, 'failed');
      updateLongArticleCta(article, 'failed');
    });

    port.postMessage({
      action: 'translate',
      payload: { paragraphs, targetLang },
    });
  }

  // ========== 在去抖后分流 Show more / DOM 回收 ==========
  function handleShowMoreOrRecycle(article: TweetArticle) {
    if (!document.contains(article)) return; // article 已从 DOM 中移除
    const tweetTextEl = findTweetTextEl(article);
    if (!tweetTextEl) return;

    const currentContentId = getContentId(article);
    const prevContentId = getState(article)?.contentId;
    const isRecycled = !!(prevContentId && currentContentId && prevContentId !== currentContentId);

    // 统一清理旧状态
    article.querySelector('.dualang-translation')?.remove();
    article.querySelector('.dualang-btn')?.remove();
    // data-dualang-mode 控制着 CSS 对原文 tweetText 的显隐；移除旧 card 时必须同步摘掉，
    // 否则 translation-only/inline/bilingual 模式下原文仍被 CSS 隐藏、card 也没了，
    // article 高度瞬间塌到 0，等翻译回来再撑起来 —— 两次跳变导致页面上移。
    article.removeAttribute('data-dualang-mode');
    hideStatus(article, true);
    translatingSet.delete(article);
    processedTweets.delete(article);
    // 新内容 / 新推文 —— 质量重试额度重置，允许它们独立触发一次重试
    delete ensureState(article).qualityRetried;

    if (isRecycled) {
      perfLog('domRecycle', { prevContentId, currentContentId });
      scanAndQueue(article); // 回收：立即按新推文处理（命中 translationCache 时直接恢复）
      return;
    }

    // 真正的 Show more / 文本变化：立即翻译
    telemetry.inc("showMoreDetected");
    if (currentContentId) {
      translationCache.delete(currentContentId);
      dictCache.dropByContentId(currentContentId);
    }
    clearDictWithBaseline(article, tweetTextEl);
    perfLog('showMore', {
      contentId: currentContentId,
      prevLen: getState(article)?.lastText?.length,
      newLen: tweetTextEl.textContent?.length
    });
    translateImmediate(article, tweetTextEl);
  }

  // 静默期去抖：每次新 mutation 到达都重置计时器，只在 mutation 停歇 SHOW_MORE_STABLE_MS 之后
  // 才触发 show-more/recycle 处理。这把阈值的含义从"X.com 展开总时长"(硬编码假设)
  // 变成"mutation 批次之间的间隔"(浏览器事件循环特性) — 不论 X.com 的动画多长都能自适应。
  function scheduleShowMoreCheck(article: TweetArticle) {
    const s = ensureState(article);
    if (s.showMoreTimer) clearTimeout(s.showMoreTimer);
    s.showMoreTimer = setTimeout(() => {
      const cur = getState(article);
      if (cur) cur.showMoreTimer = undefined;
      handleShowMoreOrRecycle(article);
    }, SHOW_MORE_STABLE_MS);
  }

  // ========== MutationObserver ==========
  function observeMutations() {
    const observer = new MutationObserver((mutations) => {
      if (!enabled) return;
      telemetry.inc("mutationObserverFires");

      // 同一次 flush 中同一个 article 只处理一次 Show more 检测
      const articlesCheckedThisFlush = new Set<Element>();

      for (const mutation of mutations) {
        // 忽略我们自己注入的字典 span 产生的 mutation —— 否则 applyDictionaryAnnotations
        // 会把所属 article 标为"文本变化"并触发 show-more 重翻循环
        if (mutation.target && (mutation.target as Element).nodeType === Node.ELEMENT_NODE) {
          const target = mutation.target as Element;
          if (target.closest?.('.dualang-dict-term') || target.closest?.('.dualang-dict-def')) continue;
        }

        // 任何涉及 article 子树的 mutation 都可能是 show-more/recycle
        // 通过 target 或 addedNodes 溯源到所属 article
        const candidates: Element[] = [];
        if (mutation.target && (mutation.target as Element).nodeType === Node.ELEMENT_NODE) {
          const art = (mutation.target as Element).closest?.('article[data-testid="tweet"]');
          if (art) candidates.push(art);
        }
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const el = node as Element;
          // 忽略我们自己新增的字典 span
          if (el.classList?.contains?.('dualang-dict-term') || el.classList?.contains?.('dualang-dict-def')) continue;
          const art = el.closest?.('article[data-testid="tweet"]');
          if (art && !candidates.includes(art)) candidates.push(art);
        }

        for (const article of candidates) {
          if (articlesCheckedThisFlush.has(article)) continue;
          const isDualangTouched =
            processedTweets.has(article) ||
            translatingSet.has(article) ||
            article.querySelector('.dualang-translation') ||
            article.querySelector('.dualang-status') ||
            article.querySelector('.dualang-btn');
          if (!isDualangTouched) continue;

          const tweetTextEl = findTweetTextEl(article);
          if (!tweetTextEl) continue;

          const art = article as TweetArticle;
          const currentText = tweetTextEl.textContent || '';
          const prevText = getState(art)?.lastText;
          // 未记录基线时不触发（避免首次注入时误判）
          if (prevText === undefined) continue;
          // 精确比较：长度相同但内容变化（编辑）也会被捕获
          if (currentText === prevText) continue;

          articlesCheckedThisFlush.add(article);
          scheduleShowMoreCheck(art);
        }

        // 收集含 article 或 Grok 摘要卡的新增根节点，留给 scanAndQueue。
        // Grok 卡没有稳定 testid/role，只能按文本特征（免责声明）粗筛；精确识别留给 scanAndQueue。
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const el = node as Element;
          const hasTweet = el.matches?.('article[data-testid="tweet"]') || el.querySelector?.('article[data-testid="tweet"]');
          const text = el.textContent || '';
          const hasGrokMarker = GROK_DISCLAIMER_PREFIXES.some((p) => text.includes(p));
          if (hasTweet || hasGrokMarker) {
            pendingScanRoots.add(el);
          }

          // 竞态防护：twitterArticleRichTextView 可能以空骨架出现在 article 里，
          // 段落后续一个个 appendChild 进去。三种检测形态：
          //   a) addedNode 本身是 richTextView
          //   b) addedNode 包含 richTextView
          //   c) addedNode 是 richTextView 的后代（段落级注入）← 原版 guard 漏掉的
          // 任一命中 + 所属 article 已被当短推文处理（有 mode / line-fusion 但没 long-article）
          // → 清理旧翻译状态，让 scanAndQueue 重新评估是否是长文。
          const richView =
            (el.matches?.('[data-testid="twitterArticleRichTextView"]') && el) ||
            el.querySelector?.('[data-testid="twitterArticleRichTextView"]') ||
            el.closest?.('[data-testid="twitterArticleRichTextView"]');
          if (richView) {
            const art = richView.closest?.('article[data-testid="tweet"]');
            const hasDirtyAttrs = art && (art.getAttribute('data-dualang-mode') || art.getAttribute('data-dualang-line-fusion'));
            if (hasDirtyAttrs) {
              if (art.getAttribute('data-dualang-long-article') === 'true') {
                // 长文已就位但被误设了 mode/line-fusion（line-fusion 的 CSS 会隐藏 richTextView → 黑屏）。
                // 只清属性和误插的 .dualang-translation 卡，保留 super-fine 的 slot 和 long-article 状态。
                art.querySelector('.dualang-translation')?.remove();
                art.removeAttribute('data-dualang-mode');
                art.removeAttribute('data-dualang-line-fusion');
              } else {
                // 短推文路径遗留的脏状态（richTextView 异步加载的竞态）：全清，重扫走长文分支。
                art.querySelector('.dualang-translation')?.remove();
                art.removeAttribute('data-dualang-mode');
                art.removeAttribute('data-dualang-line-fusion');
                processedTweets.delete(art);
                pendingScanRoots.add(art);
              }
            }
          }
        }
      }

      if (pendingScanRoots.size > 0 && !scanTimer) {
        scanTimer = setTimeout(() => {
          scanTimer = null;
          const roots = [...pendingScanRoots];
          pendingScanRoots.clear();
          for (const root of roots) scanAndQueue(root);
        }, 50);
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true  // 捕获 X.com 就地替换文本的情况（text node data 变更）
    });
  }

  // ========== 扫描并注册到两层 IntersectionObserver ==========
  function scanAndQueue(root) {
    if (!enabled) return;
    telemetry.inc("scanAndQueueCalls");
    const t0 = performance.now();
    const articles = root.matches?.('article[data-testid="tweet"]')
      ? [root]
      : root.querySelectorAll?.('article[data-testid="tweet"]') || [];
    // Grok 摘要卡作为伪 article 一起处理（findAndPrepareGrokCards 打完标记就能走同一路径）
    const grokCards = findAndPrepareGrokCards(root instanceof Element ? root : document);
    const allContainers: Element[] = [...(Array.from(articles) as Element[]), ...grokCards];

    let newlyRegistered = 0;
    let cacheRestored = 0;
    allContainers.forEach((article: Element) => {
      if (processedTweets.has(article)) return;
      processedTweets.add(article);

      const art = article as TweetArticle;
      // 记录内容 ID 和文本长度基线，用于后续 Show more / DOM 复用检测
      const contentId = getContentId(article);
      const state = ensureState(art);
      if (contentId) state.contentId = contentId;
      const tweetTextEl = findTweetTextEl(article);
      if (tweetTextEl) state.lastText = tweetTextEl.textContent || '';

      // 虚拟 DOM 回收后重现：尝试从内容 ID 缓存恢复翻译
      if (contentId && !article.querySelector('.dualang-translation')) {
        const cached = translationCache.get(contentId);
        if (cached && tweetTextEl) {
          // 精确匹配原文：内容 ID 是稳定的但内容可能被编辑/扩展/更新，
          // 只有 extractText 输出与缓存完全一致时才信任缓存。
          // 任何差异（编辑 / show-more 展开 / 截断→全文 / 引号空格变化）都作废缓存条目，
          // 让它走下方正常排队流程，由 L2 文本哈希缓存按新文本命中或重新翻译。
          const currentText = extractText(tweetTextEl);
          const stale = !cached.original || currentText !== cached.original;
          if (stale) {
            translationCache.delete(contentId);
            dictCache.dropByContentId(contentId);
            logBiz('cache.invalidate.stale', {
              contentId,
              cachedLen: cached.original?.length,
              currentLen: currentText.length,
              reason: !cached.original ? 'no-baseline' : (currentText.length === cached.original.length ? 'edit' : 'length-diff'),
            });
            // 不 return，让它走后面的 Observer 注册
          } else {
            renderTranslationLocal(article, tweetTextEl, cached.translated, cached.original);
            if (smartDictEnabled) {
              void maybeApplySmartDictionary(article, tweetTextEl, cached.original, contentId);
            } else {
              clearDictWithBaseline(article, tweetTextEl);
            }
            showSuccess(article, {
              model: cached.model, baseUrl: cached.baseUrl, fromCache: true,
            });
            cacheRestored++;
            newlyRegistered++;
            return; // 已恢复，不注册 Observer
          }
        }
      }

      // X Articles 长文：跳过常规自动翻译，在文章头部注入 CTA 链接 + 浮球入口
      if (isXArticle(article)) {
        const richTextEl = article.querySelector('[data-testid="twitterArticleRichTextView"]');
        if (richTextEl && isLongRichElement(richTextEl)) {
          article.setAttribute('data-dualang-long-article', 'true');
          if (!article.getAttribute('data-dualang-article-id')) {
            article.setAttribute('data-dualang-article-id', contentId || ('la-' + Math.random().toString(36).slice(2, 10)));
          }
          bubble.setLongArticle(article);
          injectLongArticleCta(article, richTextEl);
          newlyRegistered++;
          return; // 不注册 viewport/preload observer
        }
        // richTextView 存在但文本/块数还没到阈值 —— 典型场景是 X Articles
        // 骨架先渲染、段落异步填充。此时**不能**走短推文路径（否则译的是标题摘要，
        // 随后 richTextView 填满又会产生双重翻译 + CSS 冲突）。
        // 从 processedTweets 摘出 article，等 MutationObserver 捕获段落填充后
        // 触发 pendingScanRoots 重新评估。
        if (richTextEl) {
          processedTweets.delete(article);
          newlyRegistered++;
          return;
        }
      }

      viewportObserver?.observe(article);
      preloadObserver?.observe(article);
      newlyRegistered++;
    });
    telemetry.add("articlesScanned", newlyRegistered);
    if (newlyRegistered > 0) {
      perfLog('scanAndQueue', { newlyRegistered, cacheRestored, totalProcessed: telemetry.get('articlesScanned'), costMs: (performance.now() - t0).toFixed(2) });
    }
  }

  // ========== 自动翻译队列 ==========
  function queueTranslation(article, highPriority = false) {
    if (!enabled) return;
    telemetry.inc("queueTranslationCalls");
    // 长文走 super-fine 专属流水线（CTA/浮球触发 + fillSlot 渲染），
    // 绝不允许进入常规 translate→renderTranslation 分支，否则会被设 line-fusion
    // 触发 CSS 隐藏 richTextView（= 黑屏）。
    if (article.getAttribute('data-dualang-long-article') === 'true') return;
    if (article.querySelector('.dualang-translation')) return;
    if (translatingSet.has(article)) return;

    const statusEl = article.querySelector('.dualang-status');
    if (statusEl?.dataset.type === 'fail') return;

    if (pendingQueueSet.has(article)) {
      if (highPriority) {
        ensureState(article).isHighPriority = true;
        const idx = pendingQueue.indexOf(article);
        if (idx > 0) {
          pendingQueue.splice(idx, 1);
          pendingQueue.unshift(article);
          telemetry.inc("priorityUpgrades");
          perfLog('priorityUpgrade', { queueLength: pendingQueue.length });
        }
      }
      return;
    }

    const s = ensureState(article);
    s.enqueueTime = performance.now();
    s.isHighPriority = highPriority;

    pendingQueueSet.add(article);
    showStatus(article, 'queued');
    if (highPriority) {
      pendingQueue.unshift(article);
    } else {
      pendingQueue.push(article);
    }
    perfLog('enqueue', { highPriority, queueLength: pendingQueue.length, translatingSetSize: translatingSet.size });
    scheduler.request(highPriority);
  }

  function handleSubBatchError(err, subBatch, apiT0, rtt) {
    telemetry.inc("apiErrors");
    const isPreempted = err.message?.includes('抢占');
    const isRetryable = err.retryable !== false; // 默认可重试，除非明确标记不可重试
    logBiz('translation.request.fail', {
      error: err.message, rttMs: rtt.toFixed(1), count: subBatch.length, isPreempted, isRetryable,
    }, 'warn');
    let retried = 0;
    for (const item of subBatch) {
      translatingSet.delete(item.article);
      if (!isRetryable && !isPreempted) {
        // 不可重试错误（403/401/404 等）— 直接 fail，不浪费重试
        showFail(item.article, err.message);
      } else if (isPreempted) {
        if (!pendingQueueSet.has(item.article)) {
          pendingQueueSet.add(item.article);
          showStatus(item.article, 'queued');
          pendingQueue.unshift(item.article);
        }
        retried++;
      } else {
        const count = retryCounts.get(item.article) || 0;
        if (count < 2) {
          retryCounts.set(item.article, count + 1);
          if (!pendingQueueSet.has(item.article)) {
            pendingQueueSet.add(item.article);
            showStatus(item.article, 'queued');
            pendingQueue.unshift(item.article);
          }
          retried++;
        } else {
          showFail(item.article, err.message);
        }
      }
    }
    if (pendingQueue.length > 0) {
      let delay = 0;
      if (retried > 0) {
        if (isPreempted) {
          delay = 50;
        } else if (err.message?.includes('429') || err.message?.includes('限额')) {
          delay = 5000;
        } else {
          const maxRetry = Math.max(...subBatch.map(item => retryCounts.get(item.article) || 0));
          delay = Math.min(1000 * Math.pow(2, maxRetry - 1), 8000);
        }
      }
      setTimeout(() => scheduler.request(), delay);
    }
  }

  function flushQueue() {
    if (!enabled || pendingQueue.length === 0) return;
    telemetry.inc("flushQueueCalls");
    const flushT0 = performance.now();

    const batchArticles = pendingQueue.splice(0, BATCH_SIZE);
    for (const a of batchArticles) pendingQueueSet.delete(a);

    const batch = [];
    let batchIndex = 0;
    for (const article of batchArticles) {
      const tweetTextEl = findTweetTextEl(article);
      if (!tweetTextEl) { batchIndex++; continue; }
      if (article.querySelector('.dualang-translation')) {
        hideStatus(article, true);
        batchIndex++;
        continue;
      }

      const { text, media } = extractTextWithMedia(tweetTextEl);
      if (!text) { batchIndex++; continue; }

      if (isAlreadyTargetLanguage(text, targetLang) || shouldSkipContent(text)) {
        showPassAndHide(article);
        batchIndex++;
        continue;
      }

      // 刷新 show-more 检测基线：记录当前送翻的文本长度
      const state = ensureState(article);
      state.lastText = tweetTextEl.textContent || '';
      state.media = media;  // 译文渲染时替换 [[Mn]] 占位符（translation-only 模式不丢媒体）
      batch.push({
        article,
        text,
        tweetTextEl,
        highPriority: batchIndex < SUB_BATCH_SIZE,
        contentId: getContentId(article)  // 捕获入队时的内容 ID，响应到达前若被 X.com 虚拟 DOM 回收复用则丢弃结果
      });
      batchIndex++;
    }

    if (batch.length === 0) {
      scheduler.request();
      return;
    }

    perfLog('flushQueue', {
      dequeued: batchArticles.length,
      valid: batch.length,
      subBatches: Math.ceil(batch.length / SUB_BATCH_SIZE),
      queueRemain: pendingQueue.length,
      prepMs: (performance.now() - flushT0).toFixed(2)
    });

    if (enableStreaming) {
      flushQueueStreaming(batch);
    } else {
      flushQueueSendMessage(batch);
    }
  }

  // ========== sendMessage 模式（非流式）==========
  type BatchItem = { article: TweetArticle; text: string; tweetTextEl: Element; highPriority: boolean; contentId: string | null };

  function flushQueueSendMessage(batch: BatchItem[]) {
    let hitCap = false;
    for (let i = 0; i < batch.length; i += SUB_BATCH_SIZE) {
      if (activeRequests >= MAX_CONCURRENT) {
        hitCap = true;
        const overflow = batch.slice(i);
        for (const item of overflow) {
          if (!pendingQueueSet.has(item.article)) {
            pendingQueueSet.add(item.article);
            showStatus(item.article, 'queued');
            if (item.highPriority) pendingQueue.unshift(item.article);
            else pendingQueue.push(item.article);
          }
        }
        perfLog('concurrentCap', { capped: overflow.length, activeRequests });
        break;
      }

      const subBatch = batch.slice(i, i + SUB_BATCH_SIZE);
      for (const item of subBatch) {
        showStatus(item.article, 'loading');
        translatingSet.add(item.article);
      }

      const texts = subBatch.map(b => b.text);
      const apiT0 = performance.now();
      const hasHighPriority = subBatch.some(b => b.highPriority);

      // 统一通过 requestTranslation 分发（含 30s 超时保护）。
      withSlot(() =>
        requestTranslation(texts, hasHighPriority ? 1 : 0, false)
      ).then((data) => {
        const rtt = performance.now() - apiT0;
        telemetry.inc("apiCalls");
        telemetry.add("apiTotalRtt", rtt);
        const translations = data.translations;
        if (!Array.isArray(translations) || translations.length !== subBatch.length) {
          handleSubBatchError(new Error('子批量翻译返回结果数量不匹配'), subBatch, apiT0, rtt);
          return;
        }
        logBiz('translation.request.ok', {
          count: subBatch.length, rttMs: rtt.toFixed(1), queueRemain: pendingQueue.length, model: data.model,
        });
        const total = data.usage?.total_tokens;
        const perItem = typeof total === 'number' ? Math.round(total / subBatch.length) : undefined;
        const meta: TranslateMeta = {
          model: data.model,
          baseUrl: data.baseUrl,
          tokens: perItem,
          fromCache: !!data.fromCache,
        };
        // combined call 返回的 dictEntries 与 subBatch 顺序对齐；单次请求字典+翻译省一半 RTT
        const dictBatch: (DictEntry[] | null)[] | undefined = Array.isArray(data.dictEntries)
          ? data.dictEntries
          : undefined;
        for (let j = 0; j < subBatch.length; j++) {
          renderAndCacheResult(subBatch[j], translations[j], meta, dictBatch?.[j] ?? null);
        }
      }).catch((err) => {
        const rtt = performance.now() - apiT0;
        telemetry.inc("apiCalls");
        telemetry.add("apiTotalRtt", rtt);
        handleSubBatchError(err, subBatch, apiT0, rtt);
      });
    }

    if (!hitCap) scheduler.request();
  }

  // ========== 流式模式（port 推送，逐条渲染）==========
  function flushQueueStreaming(batch: BatchItem[]) {
    if (activeRequests >= MAX_CONCURRENT) {
      for (const item of batch) {
        if (!pendingQueueSet.has(item.article)) {
          pendingQueueSet.add(item.article);
          showStatus(item.article, 'queued');
          if (item.highPriority) pendingQueue.unshift(item.article);
          else pendingQueue.push(item.article);
        }
      }
      perfLog('concurrentCap', { capped: batch.length, activeRequests });
      return;
    }

    for (const item of batch) {
      showStatus(item.article, 'loading');
      translatingSet.add(item.article);
    }

    const texts = batch.map(b => b.text);
    const hasHighPriority = batch.some(b => b.highPriority);
    const apiT0 = performance.now();

    activeRequests++;
    bubble.setTranslationActivity(activeRequests);
    // 恰好一次释放 slot。done/error/timeout/onDisconnect 均可到达，
    // 但 activeRequests-- 与 scheduler.request() 只能执行一次。
    let slotReleased = false;
    const releaseSlot = () => {
      if (slotReleased) return;
      slotReleased = true;
      activeRequests--;
      bubble.setTranslationActivity(activeRequests);
      scheduler.request();
    };

    const port = chrome.runtime.connect(undefined, { name: 'translate-stream' });

    port.onMessage.addListener((msg) => {
      if (msg.action === 'partial') {
        const idx = msg.index;
        if (idx >= 0 && idx < batch.length && msg.translated) {
          renderAndCacheResult(batch[idx], msg.translated, { model: msg.model, baseUrl: msg.baseUrl });
        }
      } else if (msg.action === 'done') {
        const rtt = performance.now() - apiT0;
        telemetry.inc("apiCalls");
        telemetry.add("apiTotalRtt", rtt);
        perfLog('streamDone', { batchSize: batch.length, rttMs: rtt.toFixed(1), activeRequests });
        for (let j = 0; j < batch.length; j++) {
          if (translatingSet.has(batch[j].article)) {
            translatingSet.delete(batch[j].article);
            hideStatus(batch[j].article);
          }
        }
        releaseSlot();
        try { port.disconnect(); } catch (_) {}
      } else if (msg.action === 'error') {
        const rtt = performance.now() - apiT0;
        telemetry.inc("apiCalls");
        telemetry.add("apiTotalRtt", rtt);
        releaseSlot();
        const e: any = new Error(msg.error || '流式翻译失败');
        e.retryable = msg.retryable !== false;
        handleSubBatchError(e, batch, apiT0, rtt);
        try { port.disconnect(); } catch (_) {}
      }
    });

    port.onDisconnect.addListener(() => {
      // port 意外断开（Service Worker 冷重启在 done/error 之前即触发此路径）。
      // 若 slot 未释放过，这里兜底释放；否则什么都不做。
      for (const item of batch) {
        if (translatingSet.has(item.article)) {
          translatingSet.delete(item.article);
          if (!pendingQueueSet.has(item.article) && !item.article.querySelector('.dualang-translation')) {
            pendingQueueSet.add(item.article);
            showStatus(item.article, 'queued');
            pendingQueue.unshift(item.article);
          }
        }
      }
      releaseSlot();
    });

    port.postMessage({ action: 'translate', payload: { texts, priority: hasHighPriority ? 1 : 0 } });

    // 按总字符量动态超时，长文单次 batch 也能撑到完成
    const streamTotalChars = texts.reduce((a, t) => a + t.length, 0);
    const streamTimeoutMs = adaptiveTimeoutMs(streamTotalChars, STREAM_TIMEOUT_MS);
    setTimeout(() => {
      if (slotReleased) return;
      let anyStuck = false;
      for (const item of batch) {
        if (translatingSet.has(item.article)) { anyStuck = true; break; }
      }
      if (anyStuck) {
        perfLog('streamTimeout', { batchSize: batch.length, timeoutMs: streamTimeoutMs });
        releaseSlot();
        const e: any = new Error(`流式翻译超时 (${Math.round(streamTimeoutMs / 1000)}s)`);
        e.retryable = true;
        handleSubBatchError(e, batch, apiT0, performance.now() - apiT0);
        try { port.disconnect(); } catch (_) {}
      }
    }, streamTimeoutMs);
  }

  // ========== 渲染单条翻译结果 + 写入内容 ID 缓存 ==========
  function renderAndCacheResult(
    item: BatchItem,
    translated: string,
    meta?: TranslateMeta,
    freshDictEntries?: DictEntry[] | null,
  ) {
    const { article, tweetTextEl, text, contentId: originalContentId } = item;
    translatingSet.delete(article);

    // 请求在途期间 X.com 可能把 article 元素复用给另一条推文。
    // 若当前 article 的内容 ID 与入队时不一致，丢弃此结果，避免把旧翻译渲染到新推文下方。
    if (originalContentId) {
      const currentContentId = getContentId(article);
      if (currentContentId && currentContentId !== originalContentId) {
        hideStatus(article, true);
        logBiz('dom.recycle.drop', { originalContentId, currentContentId, mode: 'render' });
        return;
      }
    }

    // 异步等待期间 tweetTextEl 可能被替换，渲染前重取
    const freshTextEl = findTweetTextEl(article) || tweetTextEl;
    if (!translated) {
      hideStatus(article);
      return;
    }

    const art = article as TweetArticle;

    // 模型原样回译（短推 / 全专有名词 / 引用）—— 不是"翻译失败"，是"无需翻译"。
    // 这种情况之前会走两次质量重试然后亮红叉（"点击强制重新翻译"），UX 很吵；
    // 直接 showPassAndHide 和跳过非英文推文等同处理。仅对新鲜结果判定，缓存一致值不重复判定。
    if (!meta?.fromCache && isVerbatimReturn(text, translated)) {
      logBiz('translation.verbatim.pass', { contentId: originalContentId, origLen: text.length }, 'warn');
      showPassAndHide(article);
      return;
    }

    // 只对新鲜的 API 结果做质量检查；缓存返回的翻译是之前已经"落盘"的决策，
    // 即使当初不完美，重试也会拿到同样的结果（它就是从哪儿来的）。
    // 可疑 = 长度坍缩 或 语言错了（如目标中文但输出英文）
    const suspicious = !meta?.fromCache && (
      hasSuspiciousLineMismatch(text, translated) ||
      isWrongLanguage(translated, targetLang)
    );

    // 第一次可疑：丢弃结果，走质量重试（skipCache，避免被刚写入的坏翻译绊住）
    if (suspicious && !ensureState(art).qualityRetried) {
      ensureState(art).qualityRetried = true;
      logBiz('translation.quality.retry', {
        contentId: originalContentId, origLen: text.length, transLen: translated.length,
      }, 'warn');
      chrome.runtime.sendMessage({ action: 'recordQualityRetry' }).catch(() => {});
      translateImmediate(article, freshTextEl, true);
      return;
    }

    // 渲染（正常结果 或 已重试过的尽量使用的结果）
    renderTranslationLocal(article, freshTextEl, translated, text);
    ensureState(art).lastText = freshTextEl.textContent || '';
    if (originalContentId) {
      translationCache.set(originalContentId, {
        translated, original: text,
        model: meta?.model, baseUrl: meta?.baseUrl,
      });
    }

    if (suspicious) {
      // 重试后仍可疑：告知用户而非假装成功
      clearDictWithBaseline(article, freshTextEl);
      logBiz('translation.quality.give_up', {
        contentId: originalContentId, origLen: text.length, transLen: translated.length,
      }, 'warn');
      showFail(article, '译文与原文段落数差异过大，点击强制重新翻译', { model: meta?.model, baseUrl: meta?.baseUrl });
    } else {
      showSuccess(article, meta || {});
      // 字典三态消费（避免双重 API 浪费）：
      //   freshDictEntries === undefined → combined 没 attempt 过 → 走 fallback 独立字典 API
      //   freshDictEntries === null / [] → attempt 了但模型没给 → 静默跳过，不再发
      //   freshDictEntries = [...]        → 直接渲染，省一次 RTT
      if (Array.isArray(freshDictEntries) && freshDictEntries.length > 0) {
        if (smartDictEnabled && displayMode !== 'translation-only') {
          if (originalContentId) {
            dictCache.set(dictCache.key(originalContentId, text), freshDictEntries);
          }
          applyDictWithBaseline(article, freshTextEl, freshDictEntries);
        }
      } else if (freshDictEntries === undefined) {
        void maybeApplySmartDictionary(article, freshTextEl, text, originalContentId || undefined);
      }
      // null / [] 路径：combined 已经判定过，不再重试，用户该条无字典（模型认为都是易词）
    }
  }

  // ========== 立即翻译（Show more / 用户操作，不进队列不受并发限制）==========
  // isQualityRetry=true 时绕过缓存读取，避免刚写入的坏翻译把自己的重试吃掉
  async function translateImmediate(article: Element, tweetTextEl: Element, isQualityRetry = false) {
    const { text, media } = extractTextWithMedia(tweetTextEl);
    if (!text || isAlreadyTargetLanguage(text, targetLang) || shouldSkipContent(text)) {
      showPassAndHide(article);
      return;
    }
    // 入队时捕获内容 ID 和文本长度基线（基线用于下次 show-more 检测）
    const originalContentId = getContentId(article);
    const state0 = ensureState(article);
    state0.lastText = tweetTextEl.textContent || '';
    state0.media = media;
    showStatus(article, 'loading');
    const apiT0 = performance.now();
    // 立即通道不走 withSlot（priority 2 绕限流）但仍要让浮球转起来
    activeRequests++;
    bubble.setTranslationActivity(activeRequests);
    let released = false;
    const releaseActivity = () => { if (released) return; released = true; activeRequests--; bubble.setTranslationActivity(activeRequests); };
    try {
      // priority 2 = 最高；isQualityRetry=true 同时触发 skipCache + strictMode
      // 严格 prompt 会明确要求模型"不要总结、保留段落"，破解上一次被压缩成短译文的怪圈
      const data = await requestTranslation([text], 2, isQualityRetry, isQualityRetry);
      const rtt = performance.now() - apiT0;
      telemetry.inc("apiCalls");
      telemetry.add("apiTotalRtt", rtt);
      perfLog('immediateTranslate', { rttMs: rtt.toFixed(1) });
      const response = { success: true, data };

      // 检查 article 是否已被虚拟 DOM 回收复用
      if (originalContentId) {
        const currentContentId = getContentId(article);
        if (currentContentId && currentContentId !== originalContentId) {
          hideStatus(article, true);
          logBiz('dom.recycle.drop', { originalContentId, currentContentId, mode: 'immediate' });
          return;
        }
      }

      // 等待过程中 X.com 可能把原 tweetTextEl 换成新的 — 重新查询以避免渲染到 detached 节点
      const freshTextEl = findTweetTextEl(article) || tweetTextEl;
      const translated = response.data.translations?.[0];
      if (!translated) {
        hideStatus(article);
        return;
      }

      const art = article as TweetArticle;
      const isCacheHit = !!response.data.fromCache;

      // 模型原样回译 → showPass（详见 renderAndCacheResult 里的同款处理）
      if (!isCacheHit && isVerbatimReturn(text, translated)) {
        logBiz('translation.verbatim.pass', { contentId: originalContentId, origLen: text.length, mode: 'immediate' }, 'warn');
        showPassAndHide(article);
        return;
      }

      // 同上：缓存返回的翻译不再做质量检查 — 它就是之前落盘的决策
      const suspicious = !isCacheHit && (
        hasSuspiciousLineMismatch(text, translated) ||
        isWrongLanguage(translated, targetLang)
      );

      // 第一次可疑：重试一次（skipCache 绕过刚写入的坏翻译）
      if (suspicious && !ensureState(art).qualityRetried) {
        ensureState(art).qualityRetried = true;
        logBiz('translation.quality.retry', {
          contentId: originalContentId, origLen: text.length, transLen: translated.length, mode: 'immediate',
        }, 'warn');
        chrome.runtime.sendMessage({ action: 'recordQualityRetry' }).catch(() => {});
        translateImmediate(article, freshTextEl, true);
        return;
      }

      renderTranslationLocal(article, freshTextEl, translated, text);
      ensureState(art).lastText = freshTextEl.textContent || '';
      if (originalContentId) {
        translationCache.set(originalContentId, {
          translated, original: text,
          model: response.data.model, baseUrl: response.data.baseUrl,
        });
      }

      if (suspicious) {
        clearDictWithBaseline(article, freshTextEl);
        logBiz('translation.quality.give_up', {
          contentId: originalContentId, origLen: text.length, transLen: translated.length, mode: 'immediate',
        }, 'warn');
        showFail(article, '译文与原文段落数差异过大，点击强制重新翻译', {
          model: response.data.model, baseUrl: response.data.baseUrl,
        });
      } else {
        showSuccess(article, {
          model: response.data.model,
          baseUrl: response.data.baseUrl,
          tokens: response.data.usage?.total_tokens,
          fromCache: !!response.data.fromCache,
        });
        // 三态字典：undefined=没 attempt → fallback；null/[]=attempt 空 → 跳过；[entries]=渲染
        const freshDictEntries = Array.isArray(response.data.dictEntries)
          ? response.data.dictEntries[0]
          : undefined;
        if (Array.isArray(freshDictEntries) && freshDictEntries.length > 0
            && smartDictEnabled && displayMode !== 'translation-only') {
          if (originalContentId) {
            dictCache.set(dictCache.key(originalContentId, text), freshDictEntries);
          }
          applyDictWithBaseline(article, freshTextEl, freshDictEntries);
        } else if (freshDictEntries === undefined) {
          void maybeApplySmartDictionary(article, freshTextEl, text, originalContentId || undefined);
        }
      }
    } catch (err: any) {
      telemetry.inc("apiErrors");
      logBiz('translation.immediate.fail', { error: err.message }, 'warn');
      hideStatus(article, true);
      // 已知当前正在使用的 model/baseUrl（来自设置缓存不可得，fail 路径仅记录错误）
      showFail(article, err.message);
    } finally {
      releaseActivity();
    }
  }

  // ========== 取消观察 ==========
  function unobserveArticle(article) {
    viewportObserver?.unobserve(article);
    preloadObserver?.unobserve(article);
  }

  // ========== 状态指示器 ==========
  function showStatus(article, type) {
    let status = article.querySelector('.dualang-status');
    if (status) {
      if (status.dataset.type === type) return;
      status.className = `dualang-status dualang-status--${type}`;
      status.dataset.type = type;
      return;
    }
    const tweetTextEl = findTweetTextEl(article);
    if (!tweetTextEl) return;

    status = document.createElement('div');
    status.className = `dualang-status dualang-status--${type}`;
    status.dataset.type = type;
    const icon = document.createElement('span');
    icon.className = 'dualang-status-icon';
    status.appendChild(icon);
    tweetTextEl.parentNode.insertBefore(status, tweetTextEl.nextSibling);
  }

  function hideStatus(article, immediate = false) {
    const status = article.querySelector('.dualang-status');
    if (!status) return;
    if (immediate) { status.remove(); return; }
    status.classList.add('dualang-status--hiding');
    setTimeout(() => status.remove(), 280);
  }

  function showPassAndHide(article) {
    unobserveArticle(article);
    showStatus(article, 'pass');
    setTimeout(() => hideStatus(article), 1800);
  }

  function showFail(article: Element, errorMsg?: string, meta?: TranslateMeta) {
    unobserveArticle(article);
    showStatus(article, 'fail');
    const status = article.querySelector('.dualang-status') as HTMLElement | null;
    if (!status) return;

    // 模型 + 错误信息进 tooltip
    const m = meta?.model ? getModelMeta(meta.model, meta.baseUrl || '') : null;
    const lines = [
      m ? `${m.modelName} 翻译失败` : '翻译失败',
      errorMsg ? `原因：${errorMsg}` : null,
      '点击重新翻译'
    ].filter(Boolean);
    status.title = lines.join('\n');
    status.style.cursor = 'pointer';

    status.addEventListener('click', (e) => {
      e.stopPropagation();
      retryCounts.delete(article);
      // 重置质量重试额度，让手动触发的重试也能再自动重试一次
      delete ensureState(article).qualityRetried;
      // 清 article 下挂着的旧翻译（可能是质量不佳但已渲染的版本）；
      // 同步摘 data-dualang-mode，避免原文被 CSS 继续隐藏造成塌陷
      article.querySelector('.dualang-translation')?.remove();
      article.removeAttribute('data-dualang-mode');
      article.removeAttribute('data-dualang-line-fusion');
      hideStatus(article, true);
      // 手动重试走立即通道 + skipCache：强制新 API 调用，绕过已缓存的坏翻译
      const tweetTextEl = findTweetTextEl(article);
      if (tweetTextEl) translateImmediate(article, tweetTextEl, true);
    }, { once: true });
  }

  // 翻译成功后：状态图标变成"当前模型的品牌图标"
  // - hover：模型名 + 一句话介绍 + 本次消耗 tokens
  // - click：打开模型部署方控制台
  function showSuccess(article: Element, meta: TranslateMeta) {
    unobserveArticle(article);
    const m = getModelMeta(meta.model || '', meta.baseUrl || '');

    let status = article.querySelector('.dualang-status') as HTMLElement | null;
    const tweetTextEl = findTweetTextEl(article);
    // status 必须出现在翻译 card 之后（视觉右下角）。translation-only / inline /
    // line-fusion 模式下 tweetText 被 CSS 隐藏，若 status 仍落在 tweetText 紧邻处，
    // 会视觉漂到 card 的右上角。统一 anchor 到 card.nextSibling。
    const card = article.querySelector('.dualang-translation') as HTMLElement | null;
    if (!status) {
      const anchor = card || tweetTextEl;
      if (!anchor) return;
      status = document.createElement('div');
      anchor.parentNode!.insertBefore(status, anchor.nextSibling);
    } else if (card && status.previousElementSibling !== card) {
      card.parentNode!.insertBefore(status, card.nextSibling);
    }
    status.className = 'dualang-status dualang-status--success';
    status.dataset.type = 'success';
    status.style.cursor = 'pointer';

    // 内容：一个 <img> 图标，替代原来的 .dualang-status-icon 圆圈/叉
    const img = document.createElement('img');
    img.className = 'dualang-status-icon dualang-status-icon--brand';
    img.src = m.iconUrl;
    img.alt = m.modelName;
    img.draggable = false;
    status.replaceChildren(img);

    const tokenLine = meta.fromCache
      ? '本次：缓存命中（0 tokens）'
      : typeof meta.tokens === 'number'
        ? `本次消耗 ${meta.tokens} tokens`
        : '';
    status.title = [
      `当前模型：${m.modelName}`,
      m.modelDescription,
      tokenLine,
      '点击重新翻译，试试手气（绕过缓存，更强提示）',
    ].filter(Boolean).join('\n');

    // 用 onclick 覆盖式赋值，避免重复绑定（status 元素可能被 loading→success 复用）。
    // 点击 = 不满意当前译文 → 重新翻译：skipCache + strictMode + retranslateBoost
    // （后端会上浮温度 + 追加"精准翻译"提示），同时把 logo 换成旋转状态。
    status.onclick = (e) => {
      e.stopPropagation();
      const currentEl = findTweetTextEl(article);
      if (!currentEl) return;
      // 清掉现有译文 + 标记位，让 translateImmediate 按全新流程走
      article.querySelector('.dualang-translation')?.remove();
      article.removeAttribute('data-dualang-mode');
      article.removeAttribute('data-dualang-line-fusion');
      delete ensureState(article).qualityRetried;
      // 当前 status 元素进入"品牌图标旋转中"状态；translateImmediate 成功后
      // 会再次调用 showSuccess，替换为新的 status
      status!.classList.add('dualang-status--retranslating');
      status!.dataset.type = 'retranslating';
      translateImmediateBoost(article, currentEl);
    };
  }

  /**
   * 重新翻译（用户点击 logo 或 fail 图标触发）。封装 translateImmediate + boost flag：
   *   skipCache: 避开已缓存的坏翻译
   *   strictMode: STRICT_PREFIX 明确要求不压缩、保留段落
   *   retranslateBoost: 后端上调温度 + 追加"请更准确翻译"提示 —— 用户点击就是对
   *     当前译文不满意，需要模型给出不同角度的结果
   */
  async function translateImmediateBoost(article: Element, tweetTextEl: Element): Promise<void> {
    const { text, media } = extractTextWithMedia(tweetTextEl);
    if (!text) return;
    const originalContentId = getContentId(article);
    ensureState(article).media = media;
    activeRequests++;
    bubble.setTranslationActivity(activeRequests);
    try {
      const data = await requestTranslation([text], 2, true, true, { retranslateBoost: true });
      const translated = data.translations?.[0];
      if (!translated) { hideStatus(article); return; }
      const freshTextEl = findTweetTextEl(article) || tweetTextEl;
      renderTranslationLocal(article, freshTextEl, translated, text);
      ensureState(article as TweetArticle).lastText = freshTextEl.textContent || '';
      if (originalContentId) {
        translationCache.set(originalContentId, {
          translated, original: text, model: data.model, baseUrl: data.baseUrl,
        });
      }
      showSuccess(article, { model: data.model, baseUrl: data.baseUrl, tokens: data.usage?.total_tokens });
    } catch (err) {
      showFail(article, (err as Error)?.message);
    } finally {
      activeRequests--;
      bubble.setTranslationActivity(activeRequests);
    }
  }

  // ========== 手动翻译按钮 ==========
  function injectTranslateButton(article) {
    if (article.querySelector('.dualang-btn')) return;
    if (article.querySelector('.dualang-translation')) return;

    const tweetTextEl = findTweetTextEl(article);
    if (!tweetTextEl) return;

    const text = extractText(tweetTextEl);
    if (!text || isAlreadyTargetLanguage(text, targetLang) || shouldSkipContent(text)) return;

    const btn = document.createElement('button');
    btn.className = 'dualang-btn';
    btn.textContent = '译';
    btn.title = '翻译这条推文';

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      // 用户主动点击 — 走立即翻译通道（与 Show more / 重试一致，优先级 2）
      btn.remove();
      translateImmediate(article, tweetTextEl);
    });

    tweetTextEl.parentNode.insertBefore(btn, tweetTextEl.nextSibling);
  }

  // ========== 长文 inline CTA 链接 ==========
  // 在长文 article 的 richTextView 前注入"立即 X 光速翻译"链接，
  // 点击后触发精翻，翻译中变为"取消翻译"，完成后隐藏。
  function injectLongArticleCta(article: Element, richTextEl: Element): void {
    if (article.querySelector('.dualang-long-cta')) return;
    const cta = document.createElement('a');
    cta.className = 'dualang-long-cta';
    cta.href = 'javascript:void(0)';
    cta.textContent = ctaTranslateNow(targetLang);
    cta.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (cta.dataset.state === 'translating') {
        // 取消
        const port = getState(article)?.superFinePort;
        try { port?.disconnect(); } catch (_) {}
        return;
      }
      // 发起精翻
      translateArticleSuperFine(article);
    });
    richTextEl.parentNode?.insertBefore(cta, richTextEl);
  }

  /** 精翻状态变化时同步更新 article 内的 CTA 链接 */
  function updateLongArticleCta(article: Element, state: 'translating' | 'done' | 'failed'): void {
    const cta = article.querySelector<HTMLElement>('.dualang-long-cta');
    if (!cta) return;
    cta.dataset.state = state;
    if (state === 'translating') {
      cta.textContent = ctaCancel(targetLang);
    } else if (state === 'done') {
      cta.style.display = 'none';
    } else {
      // failed → 恢复为"立即翻译"，允许重试
      cta.textContent = ctaTranslateNow(targetLang);
    }
  }

  // 包一层闭包绑定：调用方保持 renderTranslation(article, tweetTextEl, translated, original)
  // 签名不变，内部注入 displayMode 和 onRendered 回调
  function renderTranslationLocal(
    article: Element, tweetTextEl: Element,
    translatedText: string, originalText: string,
  ) {
    const media = ensureState(article).media;
    renderTranslation(
      article,
      tweetTextEl,
      translatedText,
      originalText,
      displayMode,
      { lineFusionEnabled, media },
      unobserveArticle,
    );
  }

  init();
})();
