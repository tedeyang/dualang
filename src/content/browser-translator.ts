/**
 * W3C Translator API provider（Chrome 138+ / Edge Canary 143+ 内置翻译）。
 * 离线、无 API Key、无 token 计费；不走 background 也不走 rateLimiter。
 *
 * 参考：
 *   - Chrome: https://developer.chrome.com/docs/ai/translator-api
 *   - Edge:   https://learn.microsoft.com/en-us/microsoft-edge/web-platform/translator-api
 *   - 规范:   https://github.com/webmachinelearning/translation-api
 *
 * 协议：
 *   self.Translator.availability({sourceLanguage, targetLanguage})
 *     -> 'available' | 'downloadable' | 'downloading' | 'unavailable'
 *   self.Translator.create({sourceLanguage, targetLanguage}) -> session
 *   session.translate(text) -> Promise<string>
 *   session.destroy()
 *
 * 重要约束：availability 为 'downloadable' 或 'downloading' 时 Translator.create()
 * 必须在"用户手势"（click/touch/keydown 事件栈）内调用，否则抛
 *   "Requires a user gesture when availability is 'downloading' or 'downloadable'."
 * 因此自动翻译（viewport/scheduler 触发）不能带模型下载；得先由用户在浮球面板
 * 点击时 primeBrowserSession 把模型下载完（或至少开启下载）。
 */

interface BrowserSession {
  pair: string;
  translate: (t: string) => Promise<string>;
  destroyFn: () => void;
}

let _session: BrowserSession | null = null;

export function hasBrowserTranslator(): boolean {
  return typeof (self as any).Translator !== 'undefined';
}

/** 切换 provider / target 时调用，释放上一个 session */
export function destroyBrowserSession(): void {
  if (_session) {
    try { _session.destroyFn(); } catch (_) {}
    _session = null;
  }
}

async function ensureSession(sourceLang: string, targetLangFull: string): Promise<BrowserSession> {
  const pair = `${sourceLang}:${targetLangFull}`;
  if (_session && _session.pair === pair) return _session;
  destroyBrowserSession();

  const T = (self as any).Translator;
  const avail = await T.availability({ sourceLanguage: sourceLang, targetLanguage: targetLangFull });
  if (avail === 'unavailable') {
    const err: any = new Error(`浏览器内置翻译不支持 ${sourceLang} → ${targetLangFull}`);
    err.retryable = false;
    throw err;
  }
  const session: any = await T.create({ sourceLanguage: sourceLang, targetLanguage: targetLangFull });
  _session = {
    pair,
    translate: (text: string) => session.translate(text),
    destroyFn: () => { try { session.destroy(); } catch (_) {} },
  };
  return _session;
}

// 简化：先按"非目标语即源语为 en"处理；后续可接入 LanguageDetector.create()
function inferSourceLang(_text: string, target: string): string {
  return target.startsWith('en') ? 'zh' : 'en';
}

export interface BrowserTranslateResult {
  translations: string[];
  model: string;
  baseUrl: string;
  fromCache: boolean;
}

export async function translateViaBrowser(texts: string[], targetLang: string): Promise<BrowserTranslateResult> {
  if (!hasBrowserTranslator()) {
    const err: any = new Error('浏览器不支持内置 Translator API，请升级到 Chrome 138+ 或 Edge Canary 143+');
    err.retryable = false;
    throw err;
  }
  const sourceLang = inferSourceLang(texts[0] || '', targetLang);
  try {
    const session = await ensureSession(sourceLang, targetLang);
    const translations = await Promise.all(texts.map(t => session.translate(t)));
    return {
      translations,
      model: 'browser-native',
      baseUrl: 'browser://translator',
      fromCache: false,
    };
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (/user gesture/i.test(msg) || /downloadable|downloading/i.test(msg)) {
      // 模型未下载完；自动翻译调不到用户手势，把错误标为不可重试 + 人类可读
      const e: any = new Error('浏览器翻译模型尚未下载；请在浮球面板重新点击"浏览器本地"以触发下载');
      e.retryable = false;
      throw e;
    }
    // 其他错误默认非 retryable —— Translator API 的失败通常是环境/支持问题，重试无用
    if (!('retryable' in err)) err.retryable = false;
    throw err;
  }
}

/**
 * 预热 session：在用户点击浮球"浏览器本地"这个瞬间（user gesture 栈内）调用。
 * 若模型需要下载，此时 create() 能拿到 gesture credit 启动下载；下载期间 / 完成后
 * 再次的自动翻译就不需要手势了。
 *
 * 返回 availability 原始值供调用方做 UI（比如 '下载中'）。
 */
export type Availability = 'available' | 'downloading' | 'downloadable' | 'unavailable' | 'unsupported';

export async function primeBrowserSession(targetLang: string): Promise<Availability> {
  if (!hasBrowserTranslator()) return 'unsupported';
  const sourceLang = inferSourceLang('', targetLang);
  const T = (self as any).Translator;
  const avail: Availability = await T.availability({ sourceLanguage: sourceLang, targetLanguage: targetLang });
  if (avail === 'unavailable') return 'unavailable';
  // 即使已 'available'，也提前 create 一次把 session 缓到 _session
  // 失败（e.g., gesture 已消耗完）抛给调用方处理
  await ensureSession(sourceLang, targetLang);
  return avail;
}
