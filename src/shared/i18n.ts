// 用户界面文案本地化。保持和 popup.html 的 targetLang 选项同步：zh-CN / zh-TW / en / ja / ko。

type LangMap = Record<string, string>;

const TRANSLATE_NOW: LangMap = {
  'zh-CN': '立即 X 光速翻译',
  'zh-TW': '立即 X 光速翻譯',
  'en': 'Translate now with X-Speed',
  'ja': '今すぐ X 光速翻訳',
  'ko': '지금 X 광속 번역',
};

const CANCEL: LangMap = {
  'zh-CN': '取消翻译',
  'zh-TW': '取消翻譯',
  'en': 'Cancel',
  'ja': '翻訳を中止',
  'ko': '번역 취소',
};

const RETRY: LangMap = {
  'zh-CN': '重新翻译',
  'zh-TW': '重新翻譯',
  'en': 'Translate again',
  'ja': '再翻訳',
  'ko': '다시 번역',
};

const RETRY_FAIL: LangMap = {
  'zh-CN': '重试翻译',
  'zh-TW': '重試翻譯',
  'en': 'Retry translation',
  'ja': '翻訳を再試行',
  'ko': '번역 재시도',
};

const pick = (map: LangMap, lang: string): string => map[lang] || map['zh-CN'];

export const ctaTranslateNow = (lang: string) => pick(TRANSLATE_NOW, lang);
export const ctaCancel = (lang: string) => pick(CANCEL, lang);
export const ctaRetry = (lang: string) => pick(RETRY, lang);
export const ctaRetryFail = (lang: string) => pick(RETRY_FAIL, lang);
