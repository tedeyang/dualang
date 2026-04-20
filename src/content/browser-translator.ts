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
    throw new Error(`浏览器内置翻译不支持 ${sourceLang} → ${targetLangFull}`);
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
  const session = await ensureSession(sourceLang, targetLang);
  const translations = await Promise.all(texts.map(t => session.translate(t)));
  return {
    translations,
    model: 'browser-native',
    baseUrl: 'browser://translator',
    fromCache: false,
  };
}
