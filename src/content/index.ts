import { shouldSkipContent, isAlreadyTargetLanguage, extractText, getContentId, hasSuspiciousLineMismatch, isWrongLanguage, rebuildParagraphs, splitParagraphsByDom, splitIntoParagraphs, extractAnchoredBlocks, isLongText, isLongRichElement } from './utils';
import { getModelMeta } from '../shared/model-meta';
import * as bubble from './super-fine-bubble';
import { renderInlineSlots, fillSlot, clearInlineSlots } from './super-fine-render';
import {
  BATCH_SIZE, SUB_BATCH_SIZE, MAX_CONCURRENT,
  TRANSLATION_CACHE_MAX, TRANSLATION_CACHE_TTL_MS,
  SCHEDULER_URGENT_DELAY_MS, SCHEDULER_IDLE_DELAY_MS, SCHEDULER_MAX_AGGREGATE_MS,
  SHOW_MORE_STABLE_MS,
  REQUEST_TIMEOUT_MS, LONG_CHUNK_TIMEOUT_MS, STREAM_TIMEOUT_MS, SUPER_FINE_TIMEOUT_MS,
} from './constants';

type TranslateMeta = { model?: string; baseUrl?: string; tokens?: number; fromCache?: boolean };

// 展示模式：
//   append         —— 原文保留，译文附在下方（默认，最轻量）
//   translation-only — 仅显示译文，原文 tweetTextEl 被隐藏
//   inline         —— 段落翻译：原文 HTML 克隆 + 译文逐段交错；tweetTextEl 隐藏
//   bilingual      —— 整体对照：克隆整段原文 HTML + 整段译文；tweetTextEl 隐藏
type DisplayMode = 'append' | 'translation-only' | 'inline' | 'bilingual';

(async function () {
  'use strict';

  let enabled = true;
  let targetLang = 'zh-CN';
  let autoTranslate = true;
  let displayMode: DisplayMode = 'append';
  let enableStreaming = false;
  let providerType: 'openai' | 'browser-native' = 'openai';

  // Article 元素附加的自定义属性
  type TweetArticle = Element & {
    _dualangEnqueueTime?: number;
    _dualangIsHighPriority?: boolean;
    _dualangContentId?: string;
    _dualangLastText?: string;                                // 最近一次处理时 tweetText 的 textContent，用于精确检测内容变化（show-more / 编辑 / 长度不变但内容变）
    _dualangShowMoreTimer?: ReturnType<typeof setTimeout>;    // 静默期去抖定时器；新 mutation 到达时重置
    _dualangQualityRetried?: boolean;                         // 行数差异触发的质量重试已用掉，防止死循环
  };

  const processedTweets = new WeakSet();
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
  let viewportObserver = null;
  let preloadObserver = null;
  let activeRequests = 0;
  const retryCounts = new WeakMap();

  const pendingScanRoots = new Set();
  let scanTimer = null;

  // 性能计数器
  let perfCounters = {
    viewportObserverFires: 0,
    preloadObserverFires: 0,
    mutationObserverFires: 0,
    showMoreDetected: 0,
    scanAndQueueCalls: 0,
    articlesScanned: 0,
    queueTranslationCalls: 0,
    priorityUpgrades: 0,
    preloadCancels: 0,
    flushQueueCalls: 0,
    apiCalls: 0,
    apiTotalRtt: 0,
    apiErrors: 0,
    renderCalls: 0,
    renderTotalTime: 0
  };

  // 详细性能埋点 — 默认走 console.debug（DevTools 里 verbose 才可见），
  // 避免业务日志被海量的 enqueue / scan / render 淹没。
  function perfLog(event: string, data: any = {}) {
    console.debug('[Dualang:perf]', event, data);
  }

  // 业务语义日志 — 默认 console.log 级，保留在 Default 输出。
  // level='warn' 用于非致命的异常（abort、timeout、quality retry），
  // 'error' 用于用户可见的失败。
  function logBiz(event: string, data: any = {}, level: 'log' | 'warn' | 'error' = 'log') {
    const fn = (console as any)[level] || console.log;
    fn('[Dualang]', event, data);
  }

  let _lastSummarySnap = 0;
  setInterval(() => {
    const activity = perfCounters.apiCalls + perfCounters.renderCalls +
                     perfCounters.mutationObserverFires + perfCounters.queueTranslationCalls;
    if (activity === _lastSummarySnap && pendingQueue.length === 0 && translatingSet.size === 0) return;
    _lastSummarySnap = activity;
    const avgRtt = perfCounters.apiCalls > 0 ? (perfCounters.apiTotalRtt / perfCounters.apiCalls).toFixed(1) : '0';
    const avgRender = perfCounters.renderCalls > 0 ? (perfCounters.renderTotalTime / perfCounters.renderCalls).toFixed(2) : '0';
    perfLog('summary', {
      ...perfCounters,
      avgApiRttMs: parseFloat(avgRtt),
      avgRenderMs: parseFloat(avgRender),
      pendingQueueLength: pendingQueue.length,
      translatingSetSize: translatingSet.size
    });
  }, 10000);

  const VALID_DISPLAY_MODES: DisplayMode[] = ['append', 'translation-only', 'inline', 'bilingual'];
  function normalizeDisplayMode(mode: unknown, legacyBilingual: unknown): DisplayMode {
    if (typeof mode === 'string' && (VALID_DISPLAY_MODES as string[]).includes(mode)) {
      return mode as DisplayMode;
    }
    return legacyBilingual ? 'inline' : 'append';
  }

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
    return fn().then(
      (result) => {
        activeRequests--;
        scheduler.request();  // 槽位释放，自动尝试 drain
        return result;
      },
      (err) => {
        activeRequests--;
        scheduler.request();
        throw err;
      }
    );
  }

  // ========== 浏览器本地翻译（Chrome 138+ / Edge Canary 143+ 内置 Translator API）==========
  // W3C Translator 标准 API，Chrome 和 Edge 共用同一接口形状：
  //   self.Translator.availability({sourceLanguage, targetLanguage}) -> 'available' | 'downloadable' | 'downloading' | 'unavailable'
  //   self.Translator.create({sourceLanguage, targetLanguage}) -> session
  //   session.translate(text) -> Promise<string>
  //   session.destroy()
  // 完全离线，无 API Key，无 token 计费；不走 background 也不走 rateLimiter。
  //
  // 参考：
  //   - Chrome: https://developer.chrome.com/docs/ai/translator-api
  //   - Edge:   https://learn.microsoft.com/en-us/microsoft-edge/web-platform/translator-api
  //   - 规范:   https://github.com/webmachinelearning/translation-api
  type BrowserSession = { pair: string; translate: (t: string) => Promise<string>; destroyFn: () => void };
  let _browserSession: BrowserSession | null = null;

  function hasBrowserTranslator(): boolean {
    return typeof (self as any).Translator !== 'undefined';
  }

  async function ensureBrowserSession(sourceLang: string, targetLangFull: string): Promise<BrowserSession> {
    const pair = `${sourceLang}:${targetLangFull}`;
    if (_browserSession && _browserSession.pair === pair) return _browserSession;
    if (_browserSession) { try { _browserSession.destroyFn(); } catch (_) {} _browserSession = null; }

    const T = (self as any).Translator;
    const avail = await T.availability({ sourceLanguage: sourceLang, targetLanguage: targetLangFull });
    if (avail === 'unavailable') {
      throw new Error(`浏览器内置翻译不支持 ${sourceLang} → ${targetLangFull}`);
    }
    const session: any = await T.create({ sourceLanguage: sourceLang, targetLanguage: targetLangFull });
    _browserSession = {
      pair,
      translate: (text: string) => session.translate(text),
      destroyFn: () => { try { session.destroy(); } catch (_) {} },
    };
    return _browserSession;
  }

  // 简化：先按"非目标语即源语为 en"处理。Chrome 138+ 也提供 LanguageDetector 可进一步精化。
  function inferSourceLang(_text: string, target: string): string {
    // target 形如 'zh-CN'；source 约定用 BCP-47 主语言标签
    // 当前跳过已是目标语言的推文，所以剩下要翻译的主要是 en（以及少量其他）
    // 简单先 'en'，后续可接入 LanguageDetector.create()
    return target.startsWith('en') ? 'zh' : 'en';
  }

  async function translateViaBrowser(texts: string[]): Promise<ResponseData> {
    if (!hasBrowserTranslator()) {
      const err: any = new Error('浏览器不支持内置 Translator API，请升级到 Chrome 138+ 或 Edge Canary 143+');
      err.retryable = false;
      throw err;
    }
    const sourceLang = inferSourceLang(texts[0] || '', targetLang);
    const session = await ensureBrowserSession(sourceLang, targetLang);
    const translations = await Promise.all(texts.map(t => session.translate(t)));
    return {
      translations,
      model: 'browser-native',
      baseUrl: 'browser://translator',
      fromCache: false,
    };
  }

  // ========== 统一的翻译请求入口 ==========
  // 根据 providerType 分发到本地 Translator API 或 background HTTP 路径。
  type ResponseData = {
    translations: string[];
    usage?: { total_tokens?: number };
    model?: string;
    baseUrl?: string;
    fromCache?: boolean;
  };

  // 长文专用路径：把 text 按 \n\n 切成 N 段，5 段一 chunk 串行送 API，
  // 全部完成后 join('\n\n') 作为单段译文返回，外部调用方看不出是分多次请求完成的。
  // 串行：避免一次性占满 MAX_CONCURRENT 与 background rate limiter，让整体稳定可控。
  //
  // 通过 translate-stream port（不是 sendMessage）发起：
  //   - 超时 / content 页面切走时调 port.disconnect()
  //   - background 的 handleTranslateStream 监听 onDisconnect → AbortController.abort()
  //     → 中途的 fetch 立即取消，释放 rate-limiter 配额；避免 sendMessage 版本
  //     里超时后 background 仍跑完整个 chunk 的浪费
  async function requestTranslationChunked(
    text: string, priority: number, skipCache: boolean, strictMode: boolean,
  ): Promise<ResponseData> {
    const paragraphs = splitIntoParagraphs(text);
    const translations: string[] = new Array(paragraphs.length).fill('');
    let totalTokens = 0;
    let meta: { model?: string; baseUrl?: string } = {};
    const chunkSize = 5;

    for (let i = 0; i < paragraphs.length; i += chunkSize) {
      const chunkTexts = paragraphs.slice(i, i + chunkSize);
      const chunkResult = await requestChunkViaPort(chunkTexts, priority, i, skipCache, strictMode);
      for (let k = 0; k < chunkResult.translations.length; k++) {
        translations[i + k] = chunkResult.translations[k];
      }
      totalTokens += chunkResult.totalTokens;
      meta = { model: chunkResult.model, baseUrl: chunkResult.baseUrl };
    }
    return {
      translations: [translations.join('\n\n')],
      usage: { total_tokens: totalTokens },
      model: meta.model,
      baseUrl: meta.baseUrl,
      fromCache: false,
    };
  }

  type ChunkResult = { translations: string[]; totalTokens: number; model?: string; baseUrl?: string };

  function requestChunkViaPort(
    chunkTexts: string[], priority: number, chunkOffset: number,
    skipCache: boolean, strictMode: boolean,
  ): Promise<ChunkResult> {
    return new Promise<ChunkResult>((resolve, reject) => {
      const port = chrome.runtime.connect(undefined, { name: 'translate-stream' });
      const out: string[] = new Array(chunkTexts.length).fill('');
      let settled = false;
      let chunkModel: string | undefined;
      let chunkBaseUrl: string | undefined;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { port.disconnect(); } catch (_) {}
        reject(new Error(`长文 chunk @${chunkOffset} 翻译超时 (${LONG_CHUNK_TIMEOUT_MS / 1000}s)`));
      }, LONG_CHUNK_TIMEOUT_MS);

      port.onMessage.addListener((msg) => {
        if (settled) return;
        if (msg.action === 'partial') {
          if (typeof msg.index === 'number' && msg.index >= 0 && msg.index < out.length && msg.translated) {
            out[msg.index] = msg.translated;
            if (msg.model) chunkModel = msg.model;
            if (msg.baseUrl) chunkBaseUrl = msg.baseUrl;
          }
        } else if (msg.action === 'done') {
          settled = true;
          clearTimeout(timeout);
          // `done` 捎带一个完整 translations 数组 —— 覆写 partial 收集的结果以确保完整性
          const finalTranslations = Array.isArray(msg.translations)
            ? msg.translations.map((t: any, i: number) => t || out[i])
            : out;
          resolve({
            translations: finalTranslations,
            totalTokens: 0,  // translate-stream 不上报 usage（缓存命中也算 0），不影响外层统计
            model: msg.model || chunkModel,
            baseUrl: msg.baseUrl || chunkBaseUrl,
          });
          try { port.disconnect(); } catch (_) {}
        } else if (msg.action === 'error') {
          settled = true;
          clearTimeout(timeout);
          const e: any = new Error(msg.error || `长文 chunk @${chunkOffset} 失败`);
          e.retryable = msg.retryable !== false;
          reject(e);
          try { port.disconnect(); } catch (_) {}
        }
      });

      port.onDisconnect.addListener(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`长文 chunk @${chunkOffset} 连接断开`));
      });

      port.postMessage({
        action: 'translate',
        payload: { texts: chunkTexts, priority, skipCache, strictMode },
      });
    });
  }

  async function requestTranslation(
    texts: string[],
    priority: number,
    skipCache = false,
    strictMode = false,
  ): Promise<ResponseData> {
    if (providerType === 'browser-native') {
      return translateViaBrowser(texts);  // 浏览器本地翻译不支持 strict 模式
    }
    // 长文（单条 4k+ 字符 + 6+ 段落）自动切段：小模型在整包 20k 字符输入下
    // 会把 N 段输出压成 2 段，切成 5-段一组的独立 sub-batch 各自翻译能保证段落数对齐。
    if (texts.length === 1 && isLongText(texts[0])) {
      return requestTranslationChunked(texts[0], priority, skipCache, strictMode);
    }
    const response: any = await Promise.race([
      chrome.runtime.sendMessage({
        action: 'translate',
        payload: { texts, priority, skipCache, strictMode },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`翻译请求超时 (${REQUEST_TIMEOUT_MS / 1000}s)`)), REQUEST_TIMEOUT_MS)),
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

  // ========== 初始化 ==========
  async function init() {
    const t0 = performance.now();
    const settings = await chrome.storage.sync.get({
      enabled: true,
      targetLang: 'zh-CN',
      autoTranslate: true,
      displayMode: null,  // null 哨兵：未设时根据老 bilingualMode 迁移
      bilingualMode: false,
      enableStreaming: false,
      providerType: 'openai'
    });
    enabled         = settings.enabled;
    targetLang      = settings.targetLang   || 'zh-CN';
    autoTranslate   = settings.autoTranslate !== false;
    // 迁移：老用户 displayMode 未设，根据 bilingualMode 推导；bilingualMode=true → 'inline'（升级到段落对照）
    displayMode     = normalizeDisplayMode(settings.displayMode, settings.bilingualMode);
    enableStreaming  = !!settings.enableStreaming;
    providerType    = settings.providerType === 'browser-native' ? 'browser-native' : 'openai';
    perfLog('init', {
      enabled, targetLang, autoTranslate, displayMode,
      initCostMs: (performance.now() - t0).toFixed(2)
    });
    ensureBgPort();
    bubble.initBubble({
      onTrigger: (articleId: string) => {
        const article = document.querySelector(`[data-dualang-article-id="${articleId}"]`);
        if (article) translateArticleSuperFine(article);
      },
      onCancel: (articleId: string) => {
        const article = document.querySelector(`[data-dualang-article-id="${articleId}"]`);
        const port = (article as any)?._dualangSuperFinePort;
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
  chrome.runtime.onMessage.addListener((request: any, _sender, _sendResponse) => {
    if (request.action === 'toggle') {
      enabled = request.enabled;
      console.log('[Dualang] toggled, enabled=', enabled);
      if (enabled) {
        scanAndQueue(document.body);
        if (autoTranslate) flushQueue();
      }
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.targetLang)                  targetLang     = changes.targetLang.newValue    || 'zh-CN';
    if (changes.autoTranslate !== undefined)  autoTranslate  = changes.autoTranslate.newValue !== false;
    if (changes.displayMode !== undefined)    displayMode    = normalizeDisplayMode(changes.displayMode.newValue, false);
    if (changes.enableStreaming !== undefined) enableStreaming = !!changes.enableStreaming.newValue;
    if (changes.providerType !== undefined) {
      const v = changes.providerType.newValue;
      providerType = v === 'browser-native' ? 'browser-native' : 'openai';
      // 切换 provider 时，清空浏览器本地 session 缓存
      _browserSession?.destroyFn?.();
      _browserSession = null;
    }
  });

  // ========== 两层 IntersectionObserver ==========
  function setupIntersectionObservers() {
    if (viewportObserver) return;
    const vh = window.innerHeight || 800;

    viewportObserver = new IntersectionObserver((entries) => {
      if (!enabled) return;
      perfCounters.viewportObserverFires += entries.length;
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const article = entry.target;
        if (autoTranslate) queueTranslation(article, true);
        else injectTranslateButton(article);
      });
    }, { threshold: 0.05 });

    preloadObserver = new IntersectionObserver((entries) => {
      if (!enabled) return;
      perfCounters.preloadObserverFires += entries.length;
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
        if (art._dualangIsHighPriority) return;
        const idx = pendingQueue.indexOf(art);
        if (idx === -1) return;
        pendingQueue.splice(idx, 1);
        pendingQueueSet.delete(article);
        hideStatus(article, true);
        perfCounters.preloadCancels++;
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
    const articleId = article.getAttribute('data-dualang-article-id');
    if (!articleId) return;
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

    // img-alt 块用 "[图: alt]" 发给模型，便于作为独立段落翻译
    const paragraphs = blocks.map((b) => b.kind === 'img-alt' ? `[图: ${b.text}]` : b.text);
    const apiT0 = performance.now();
    logBiz('translation.superFine.start', { paragraphs: blocks.length });

    let finished = false;
    let port: chrome.runtime.Port | null = null;
    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { port?.disconnect(); } catch (_) {}
      bubble.setBubbleState(articleId, 'failed');
      logBiz('translation.superFine.fail', { error: 'timeout' }, 'warn');
    }, SUPER_FINE_TIMEOUT_MS);

    try {
      port = chrome.runtime.connect(undefined, { name: 'super-fine' });
    } catch (err: any) {
      clearTimeout(timeout);
      bubble.setBubbleState(articleId, 'failed');
      logBiz('translation.superFine.fail', { error: 'connect:' + err.message }, 'warn');
      return;
    }

    (article as any)._dualangSuperFinePort = port;
    let metaModel: string | undefined;
    let metaBaseUrl: string | undefined;

    port.onMessage.addListener((msg: any) => {
      if (finished) return;
      if (msg.action === 'meta') {
        metaModel = msg.model;
        metaBaseUrl = msg.baseUrl;
      } else if (msg.action === 'partial') {
        fillSlot(article, msg.index, msg.translated);
      } else if (msg.action === 'progress') {
        bubble.setBubbleState(articleId, 'translating', { completed: msg.completed, total: msg.total });
      } else if (msg.action === 'chunkFail') {
        logBiz('translation.superFine.chunkFail', { chunkIndex: msg.chunkIndex, error: msg.error }, 'warn');
      } else if (msg.action === 'done') {
        finished = true;
        clearTimeout(timeout);
        bubble.setBubbleState(articleId, 'done');
        const rtt = performance.now() - apiT0;
        showSuccess(article, { model: msg.model || metaModel, baseUrl: msg.baseUrl || metaBaseUrl, tokens: msg.totalTokens });
        logBiz('translation.superFine.ok', {
          paragraphs: blocks.length, completed: msg.completed, rttMs: rtt.toFixed(0), model: msg.model || metaModel,
        });
        try { port?.disconnect(); } catch (_) {}
      } else if (msg.action === 'error') {
        finished = true;
        clearTimeout(timeout);
        bubble.setBubbleState(articleId, 'failed');
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
    });

    port.postMessage({
      action: 'translate',
      payload: { paragraphs, targetLang },
    });
  }

  /**
   * Grok 摘要卡识别：没有 testid/role/aria，只能结构 + 语义两类信号组合。
   * 早期纯靠结构指纹（4 个 DIV 子 + 含 time + 免责声明前缀），X.com 改一次 DOM 就挂。
   * 现在把识别拆成多个独立信号，按置信度计分通过：
   *   - 必选：disclaimer 短语（多语言）——这是卡的本质特征，改版也大概率保留
   *   - 辅助：结构（4 个 div 子）、<time> 存在、容器 aria-label 提示
   * 只要 disclaimer 命中且至少一个辅助信号命中就认；即使未来 X.com 把 4 个 div
   * 变成 3 个或加了 SVG 图标节点，只要免责声明还在就不至于完全识别失败。
   */
  // 多语言免责声明开头（所有已知 locale）；通过 startsWith 容忍后续文案变化
  const GROK_DISCLAIMER_PREFIXES = [
    'This story is a summary of posts on X',  // en
    '此新闻是 X 上帖子的摘要',                   // zh-CN
    '此新聞是 X 上貼文的摘要',                   // zh-TW
  ];

  function hasGrokDisclaimer(el: Element): boolean {
    const text = (el.textContent || '').trim();
    return GROK_DISCLAIMER_PREFIXES.some((p) => text.startsWith(p));
  }

  function isGrokCardContainer(el: Element): boolean {
    if (!(el instanceof Element)) return false;
    // 必选：最后一个子节点的文本以 disclaimer 开头（子树包含 disclaimer 不够 ——
    // Grok 卡的祖先会把整段文字拢进 textContent 但 disclaimer 不在其子首）
    const lastChild = el.children[el.children.length - 1];
    if (!lastChild || !hasGrokDisclaimer(lastChild)) return false;

    // 至少命中一个辅助信号，排除偶发的包含 disclaimer 文本的无关容器
    let signals = 0;
    if (el.children.length === 4) signals++;
    if (el.querySelector('time')) signals++;
    // aria-label / role 上的提示（X.com 未来加上就能命中，加不上也不关键）
    const aria = el.getAttribute('aria-label') || '';
    if (/grok|trending|热点|趨勢/i.test(aria)) signals++;
    return signals >= 1;
  }

  // 在一棵子树里发现所有未处理的 Grok 卡片，打上标记后返回。
  // 用 data-dualang-grok 做 idempotent guard，避免重复处理同一张卡。
  function findAndPrepareGrokCards(root: Element | Document): Element[] {
    const scope: any = root instanceof Element ? root : document;
    // 候选集：用 `:has(time)` 先粗筛再细判；浏览器支持差异用 try/catch 兜底
    let candidates: Element[] = [];
    try {
      candidates = Array.from(scope.querySelectorAll('div:has(> time), div:has(time)'));
    } catch (_) {
      candidates = Array.from(scope.querySelectorAll('div'));
    }
    const cards: Element[] = [];
    for (const el of candidates) {
      // 从候选往上找到 4-子 + 免责声明的最小容器 —— 因为我们刚粗筛了 <time>，其祖先都可能命中
      let node: Element | null = el;
      for (let i = 0; i < 6 && node; i++) {
        if (isGrokCardContainer(node)) {
          if (!node.hasAttribute('data-dualang-grok')) {
            // children[2] 是正文 wrapper，内层的 div[dir] 是真正的文本元素
            const bodyWrapper = node.children[2];
            const bodyEl = bodyWrapper?.querySelector('div[dir]') || bodyWrapper?.querySelector('div');
            if (bodyEl) {
              node.setAttribute('data-dualang-grok', 'true');
              bodyEl.setAttribute('data-dualang-text', 'true');
              cards.push(node);
            }
          }
          break;
        }
        node = node.parentElement;
      }
    }
    return cards;
  }

  // ========== 在去抖后分流 Show more / DOM 回收 ==========
  function handleShowMoreOrRecycle(article: TweetArticle) {
    if (!document.contains(article)) return; // article 已从 DOM 中移除
    const tweetTextEl = findTweetTextEl(article);
    if (!tweetTextEl) return;

    const currentContentId = getContentId(article);
    const prevContentId = article._dualangContentId;
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
    delete (article as TweetArticle)._dualangQualityRetried;

    if (isRecycled) {
      perfLog('domRecycle', { prevContentId, currentContentId });
      scanAndQueue(article); // 回收：立即按新推文处理（命中 translationCache 时直接恢复）
      return;
    }

    // 真正的 Show more / 文本变化：立即翻译
    perfCounters.showMoreDetected++;
    if (currentContentId) translationCache.delete(currentContentId);
    perfLog('showMore', {
      contentId: currentContentId,
      prevLen: article._dualangLastText?.length,
      newLen: tweetTextEl.textContent?.length
    });
    translateImmediate(article, tweetTextEl);
  }

  // 静默期去抖：每次新 mutation 到达都重置计时器，只在 mutation 停歇 SHOW_MORE_STABLE_MS 之后
  // 才触发 show-more/recycle 处理。这把阈值的含义从"X.com 展开总时长"(硬编码假设)
  // 变成"mutation 批次之间的间隔"(浏览器事件循环特性) — 不论 X.com 的动画多长都能自适应。
  function scheduleShowMoreCheck(article: TweetArticle) {
    if (article._dualangShowMoreTimer) clearTimeout(article._dualangShowMoreTimer);
    article._dualangShowMoreTimer = setTimeout(() => {
      article._dualangShowMoreTimer = undefined;
      handleShowMoreOrRecycle(article);
    }, SHOW_MORE_STABLE_MS);
  }

  // ========== MutationObserver ==========
  function observeMutations() {
    const observer = new MutationObserver((mutations) => {
      if (!enabled) return;
      perfCounters.mutationObserverFires++;

      // 同一次 flush 中同一个 article 只处理一次 Show more 检测
      const articlesCheckedThisFlush = new Set<Element>();

      for (const mutation of mutations) {
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
          const prevText = art._dualangLastText;
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
    perfCounters.scanAndQueueCalls++;
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
      if (contentId) art._dualangContentId = contentId;
      const tweetTextEl = findTweetTextEl(article);
      if (tweetTextEl) art._dualangLastText = tweetTextEl.textContent || '';

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
            logBiz('cache.invalidate.stale', {
              contentId,
              cachedLen: cached.original?.length,
              currentLen: currentText.length,
              reason: !cached.original ? 'no-baseline' : (currentText.length === cached.original.length ? 'edit' : 'length-diff'),
            });
            // 不 return，让它走后面的 Observer 注册
          } else {
            renderTranslation(article, tweetTextEl, cached.translated, cached.original);
            showSuccess(article, {
              model: cached.model, baseUrl: cached.baseUrl, fromCache: true,
            });
            cacheRestored++;
            newlyRegistered++;
            return; // 已恢复，不注册 Observer
          }
        }
      }

      // X Articles 长文：跳过常规自动翻译，改由浮球交互触发
      // 用 twitterArticleRichTextView 作为正文容器，不用通用 tweetTextEl
      // （避免 querySelector 优先命中同 article 内的短 tweetText 预览元素）
      if (isXArticle(article)) {
        const richTextEl = article.querySelector('[data-testid="twitterArticleRichTextView"]');
        if (richTextEl && isLongRichElement(richTextEl)) {
          article.setAttribute('data-dualang-long-article', 'true');
          if (!article.getAttribute('data-dualang-article-id')) {
            article.setAttribute('data-dualang-article-id', contentId || ('la-' + Math.random().toString(36).slice(2, 10)));
          }
          bubble.trackArticle(article);
          newlyRegistered++;
          return; // 不注册 viewport/preload observer
        }
      }

      viewportObserver?.observe(article);
      preloadObserver?.observe(article);
      newlyRegistered++;
    });
    perfCounters.articlesScanned += newlyRegistered;
    if (newlyRegistered > 0) {
      perfLog('scanAndQueue', { newlyRegistered, cacheRestored, totalProcessed: perfCounters.articlesScanned, costMs: (performance.now() - t0).toFixed(2) });
    }
  }

  // ========== 自动翻译队列 ==========
  function queueTranslation(article, highPriority = false) {
    if (!enabled) return;
    perfCounters.queueTranslationCalls++;
    if (article.querySelector('.dualang-translation')) return;
    if (translatingSet.has(article)) return;

    const statusEl = article.querySelector('.dualang-status');
    if (statusEl?.dataset.type === 'fail') return;

    if (pendingQueueSet.has(article)) {
      if (highPriority) {
        article._dualangIsHighPriority = true;
        const idx = pendingQueue.indexOf(article);
        if (idx > 0) {
          pendingQueue.splice(idx, 1);
          pendingQueue.unshift(article);
          perfCounters.priorityUpgrades++;
          perfLog('priorityUpgrade', { queueLength: pendingQueue.length });
        }
      }
      return;
    }

    article._dualangEnqueueTime = performance.now();
    article._dualangIsHighPriority = highPriority;

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
    perfCounters.apiErrors++;
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
    perfCounters.flushQueueCalls++;
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

      const text = extractText(tweetTextEl);
      if (!text) { batchIndex++; continue; }

      if (isAlreadyTargetLanguage(text, targetLang) || shouldSkipContent(text)) {
        showPassAndHide(article);
        batchIndex++;
        continue;
      }

      // 刷新 show-more 检测基线：记录当前送翻的文本长度
      (article as TweetArticle)._dualangLastText = tweetTextEl.textContent || '';
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

      // 统一通过 requestTranslation 分发（openai HTTP 或 browser-native）。内含 30s 超时保护。
      withSlot(() =>
        requestTranslation(texts, hasHighPriority ? 1 : 0, false)
      ).then((data) => {
        const rtt = performance.now() - apiT0;
        perfCounters.apiCalls++;
        perfCounters.apiTotalRtt += rtt;
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
        for (let j = 0; j < subBatch.length; j++) {
          renderAndCacheResult(subBatch[j], translations[j], meta);
        }
      }).catch((err) => {
        const rtt = performance.now() - apiT0;
        perfCounters.apiCalls++;
        perfCounters.apiTotalRtt += rtt;
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
    // 恰好一次释放 slot。done/error/timeout/onDisconnect 均可到达，
    // 但 activeRequests-- 与 scheduler.request() 只能执行一次。
    let slotReleased = false;
    const releaseSlot = () => {
      if (slotReleased) return;
      slotReleased = true;
      activeRequests--;
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
        perfCounters.apiCalls++;
        perfCounters.apiTotalRtt += rtt;
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
        perfCounters.apiCalls++;
        perfCounters.apiTotalRtt += rtt;
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

    // 30s 超时保护
    setTimeout(() => {
      if (slotReleased) return;
      let anyStuck = false;
      for (const item of batch) {
        if (translatingSet.has(item.article)) { anyStuck = true; break; }
      }
      if (anyStuck) {
        perfLog('streamTimeout', { batchSize: batch.length });
        releaseSlot();
        const e: any = new Error(`流式翻译超时 (${STREAM_TIMEOUT_MS / 1000}s)`);
        e.retryable = true;
        handleSubBatchError(e, batch, apiT0, performance.now() - apiT0);
        try { port.disconnect(); } catch (_) {}
      }
    }, STREAM_TIMEOUT_MS);
  }

  // ========== 渲染单条翻译结果 + 写入内容 ID 缓存 ==========
  function renderAndCacheResult(item: BatchItem, translated: string, meta?: TranslateMeta) {
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
    // 只对新鲜的 API 结果做质量检查；缓存返回的翻译是之前已经"落盘"的决策，
    // 即使当初不完美，重试也会拿到同样的结果（它就是从哪儿来的）。
    // 可疑 = 长度坍缩 或 语言错了（如目标中文但输出英文）
    const suspicious = !meta?.fromCache && (
      hasSuspiciousLineMismatch(text, translated) ||
      isWrongLanguage(translated, targetLang)
    );

    // 第一次可疑：丢弃结果，走质量重试（skipCache，避免被刚写入的坏翻译绊住）
    if (suspicious && !art._dualangQualityRetried) {
      art._dualangQualityRetried = true;
      logBiz('translation.quality.retry', {
        contentId: originalContentId, origLen: text.length, transLen: translated.length,
      }, 'warn');
      chrome.runtime.sendMessage({ action: 'recordQualityRetry' }).catch(() => {});
      translateImmediate(article, freshTextEl, true);
      return;
    }

    // 渲染（正常结果 或 已重试过的尽量使用的结果）
    renderTranslation(article, freshTextEl, translated, text);
    art._dualangLastText = freshTextEl.textContent || '';
    if (originalContentId) {
      translationCache.set(originalContentId, {
        translated, original: text,
        model: meta?.model, baseUrl: meta?.baseUrl,
      });
    }

    if (suspicious) {
      // 重试后仍可疑：告知用户而非假装成功
      logBiz('translation.quality.give_up', {
        contentId: originalContentId, origLen: text.length, transLen: translated.length,
      }, 'warn');
      showFail(article, '译文与原文段落数差异过大，点击强制重新翻译', { model: meta?.model, baseUrl: meta?.baseUrl });
    } else {
      showSuccess(article, meta || {});
    }
  }

  // ========== 立即翻译（Show more / 用户操作，不进队列不受并发限制）==========
  // isQualityRetry=true 时绕过缓存读取，避免刚写入的坏翻译把自己的重试吃掉
  async function translateImmediate(article: Element, tweetTextEl: Element, isQualityRetry = false) {
    const text = extractText(tweetTextEl);
    if (!text || isAlreadyTargetLanguage(text, targetLang) || shouldSkipContent(text)) {
      showPassAndHide(article);
      return;
    }
    // 入队时捕获内容 ID 和文本长度基线（基线用于下次 show-more 检测）
    const originalContentId = getContentId(article);
    (article as TweetArticle)._dualangLastText = tweetTextEl.textContent || '';
    showStatus(article, 'loading');
    const apiT0 = performance.now();
    try {
      // priority 2 = 最高；isQualityRetry=true 同时触发 skipCache + strictMode
      // 严格 prompt 会明确要求模型"不要总结、保留段落"，破解上一次被压缩成短译文的怪圈
      const data = await requestTranslation([text], 2, isQualityRetry, isQualityRetry);
      const rtt = performance.now() - apiT0;
      perfCounters.apiCalls++;
      perfCounters.apiTotalRtt += rtt;
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
      // 同上：缓存返回的翻译不再做质量检查 — 它就是之前落盘的决策
      const suspicious = !isCacheHit && (
        hasSuspiciousLineMismatch(text, translated) ||
        isWrongLanguage(translated, targetLang)
      );

      // 第一次可疑：重试一次（skipCache 绕过刚写入的坏翻译）
      if (suspicious && !art._dualangQualityRetried) {
        art._dualangQualityRetried = true;
        logBiz('translation.quality.retry', {
          contentId: originalContentId, origLen: text.length, transLen: translated.length, mode: 'immediate',
        }, 'warn');
        chrome.runtime.sendMessage({ action: 'recordQualityRetry' }).catch(() => {});
        translateImmediate(article, freshTextEl, true);
        return;
      }

      renderTranslation(article, freshTextEl, translated, text);
      art._dualangLastText = freshTextEl.textContent || '';
      if (originalContentId) {
        translationCache.set(originalContentId, {
          translated, original: text,
          model: response.data.model, baseUrl: response.data.baseUrl,
        });
      }

      if (suspicious) {
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
      }
    } catch (err: any) {
      perfCounters.apiErrors++;
      logBiz('translation.immediate.fail', { error: err.message }, 'warn');
      hideStatus(article, true);
      // 已知当前正在使用的 model/baseUrl（来自设置缓存不可得，fail 路径仅记录错误）
      showFail(article, err.message);
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
      delete (article as TweetArticle)._dualangQualityRetried;
      // 清 article 下挂着的旧翻译（可能是质量不佳但已渲染的版本）；
      // 同步摘 data-dualang-mode，避免原文被 CSS 继续隐藏造成塌陷
      article.querySelector('.dualang-translation')?.remove();
      article.removeAttribute('data-dualang-mode');
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
    if (!status) {
      if (!tweetTextEl) return;
      status = document.createElement('div');
      tweetTextEl.parentNode!.insertBefore(status, tweetTextEl.nextSibling);
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
    status.title = [m.modelName, m.modelDescription, tokenLine, '点击访问官网'].filter(Boolean).join('\n');

    // 用 onclick 覆盖式赋值，避免重复绑定（status 元素可能被 loading→success 复用）
    status.onclick = (e) => {
      e.stopPropagation();
      try { window.open(m.apiDeployUrl, '_blank', 'noopener,noreferrer'); } catch (_) {}
    };
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

  // ========== 渲染翻译块 ==========
  // 4 种展示模式：
  //   append          —— 原文 tweetText 保留可见，译文 card 追加在其下方
  //   translation-only —— 原文隐藏（CSS 通过 article[data-dualang-mode] 控制），只显示译文
  //   inline          —— 原文隐藏；card 内逐段交错：[克隆的原文段落 HTML] + [对应译文]
  //   bilingual       —— 原文隐藏；card 内先显示整段原文 HTML 克隆，下方跟整段译文
  // 为什么需要 data-dualang-mode 属性：mode 切换时旧推文保留老模式、新推文用新模式，
  // CSS 的 :has 或属性选择器根据 article 的 mode 决定是否隐藏 tweetTextEl。
  function renderTranslation(article, tweetTextEl, translatedText, originalText) {
    const t0 = performance.now();
    if (article.querySelector('.dualang-translation')) return;

    const card = document.createElement('div');
    card.className = 'dualang-translation';
    const mode = displayMode;
    article.setAttribute('data-dualang-mode', mode);

    let translatedParas = translatedText
      .split(/(?:\n\s*\n|---PARA---)/)
      .map(p => p.trim())
      .filter(Boolean);
    if (translatedParas.length === 0) translatedParas.push(translatedText.trim());

    // 译文救援：模型没有按"保留段落"指令输出 \n\n，但原文确实有多段落
    // → 按句末标点重建段落结构，避免渲染成一大坨文字
    if (translatedParas.length === 1 && originalText) {
      const origParas = originalText.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).length;
      if (origParas >= 3) {
        const rebuilt = rebuildParagraphs(translatedParas[0], origParas);
        if (rebuilt.length >= 2) {
          translatedParas = rebuilt;
          perfLog('paraRebuild', { origParas, newParas: rebuilt.length });
        }
      }
    }

    if (mode === 'inline') {
      // 段落对照：按 DOM 边界克隆原文各段，紧接对应译文；段数不对等时取原文段数为准，
      // 多出的译文段落作为最后一段译文块；少的译文位置留空（用户能看到原文提示模型漏译）
      card.classList.add('dualang-inline');
      const originalParas = splitParagraphsByDom(tweetTextEl);
      // 段数严重不匹配（比如 X Articles 的原文 DOM 只切出 5 段但译文有 25 段，因为
      // 文章的段落边界靠 CSS block 布局而非文本节点 \n\n 分隔）→ 退回整体对照布局，
      // 避免大量译文散落在末尾。门槛：原文段数 < 译文段数 × 0.5 视为严重不匹配。
      const severeMismatch = originalParas.length > 0
        && translatedParas.length > 2
        && originalParas.length < translatedParas.length * 0.5;
      if (originalParas.length === 0 || severeMismatch) {
        // 退化路径：克隆整段原文 HTML + 译文整块（bilingual 风格）
        const origBlock = document.createElement('div');
        origBlock.className = 'dualang-original-html';
        for (const child of Array.from(tweetTextEl.childNodes) as Node[]) {
          origBlock.appendChild(child.cloneNode(true));
        }
        card.appendChild(origBlock);
        appendTranslationParas(card, translatedParas);
        if (severeMismatch) {
          perfLog('inline.fallbackToBilingual', { origParas: originalParas.length, transParas: translatedParas.length });
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
            trans.textContent = translatedParas[i];
            pair.appendChild(trans);
          }
          card.appendChild(pair);
        }
        // 译文多出的尾段：按一段译文块追加
        for (let i = originalParas.length; i < translatedParas.length; i++) {
          const trans = document.createElement('div');
          trans.className = 'dualang-para';
          trans.textContent = translatedParas[i];
          card.appendChild(trans);
        }
      }
    } else if (mode === 'bilingual') {
      // 整体对照：克隆整段原文 HTML（保留链接/emoji/@/#）+ 整段译文
      card.classList.add('dualang-bilingual');
      const origBlock = document.createElement('div');
      origBlock.className = 'dualang-original-html';
      for (const child of Array.from(tweetTextEl.childNodes) as Node[]) {
        origBlock.appendChild(child.cloneNode(true));
      }
      card.appendChild(origBlock);
      appendTranslationParas(card, translatedParas);
    } else {
      // 'append' 和 'translation-only' 共享译文-only 的 card 结构；
      // 区别只在 CSS 是否隐藏 tweetTextEl（由 data-dualang-mode 控制）
      appendTranslationParas(card, translatedParas);
    }

    tweetTextEl.parentNode.insertBefore(card, tweetTextEl.nextSibling);
    unobserveArticle(article);
    const cost = performance.now() - t0;
    perfCounters.renderCalls++;
    perfCounters.renderTotalTime += cost;
    perfLog('render', { paras: translatedParas.length, mode, costMs: cost.toFixed(2) });
  }

  // 渲染整段译文：把多个段落合并回一个 pre-wrap 块，\n\n 由 CSS 的 white-space 原生渲染为
  // 一整行空行（与 X.com 原生 tweetText 的段落间距视觉一致）。
  // 旧做法是每段一个 <div> + margin-top 近似，但 margin 值永远对不齐 line-height 撑出的空行。
  function appendTranslationParas(card: HTMLElement, translatedParas: string[]) {
    if (translatedParas.length === 0) return;
    const p = document.createElement('div');
    p.className = 'dualang-para';
    p.textContent = translatedParas.join('\n\n');
    card.appendChild(p);
  }

  init();
})();
