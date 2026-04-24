/**
 * 插件 i18n 核心：UiLang 类型 + 检测，以及 content 侧（bubble + CTA）所需文案。
 *
 * popup 的完整文案目录在 `i18n-popup.ts` 里（~80 key × 5 语言），content 不需要
 * 整包带上，所以这里只放 content 会用到的 key。
 *
 * 设计：
 *   - `uiLang` 独立于 `targetLang`（翻译成什么语言 vs 界面用什么语言）
 *   - 优先用户存的 `uiLang`；缺省根据浏览器 UI 语言自动检测
 *   - Fallback 链：目标 → en → zh-CN → key 本身
 */

export type UiLang = 'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'ko';

export const UI_LANGS: Array<{ code: UiLang; label: string }> = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
];

/** 浏览器 / 系统语言 → 扩展支持的 UiLang 码；无匹配回落到 en */
export function detectDefaultUiLang(): UiLang {
  let raw = '';
  try {
    raw = (typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage?.()) || '';
  } catch {}
  if (!raw && typeof navigator !== 'undefined') raw = navigator.language || '';
  const lower = String(raw).toLowerCase();
  if (lower.startsWith('zh')) {
    if (lower.includes('tw') || lower.includes('hk') || lower.includes('mo') || lower.includes('hant')) {
      return 'zh-TW';
    }
    return 'zh-CN';
  }
  if (lower.startsWith('ja')) return 'ja';
  if (lower.startsWith('ko')) return 'ko';
  if (lower.startsWith('en')) return 'en';
  return 'en';
}

// ========== Content 侧文案（bubble + CTA）==========

type Dict = Partial<Record<string, string>>;

const ZH_CN: Dict = {
  // CTA buttons（译文卡上的"立即翻译 / 取消 / 重试"）
  'cta.translateNow': '立即 X 光速翻译',
  'cta.cancel': '取消翻译',
  'cta.retry': '重新翻译',
  'cta.retryFail': '重试翻译',

  // Bubble（浮球面板）
  'bubble.enableTranslation': '开启翻译',
  'bubble.dict': '字典',
  'bubble.dictTooltip': '智能字典（英文原文生僻词）',
  'bubble.lineFusionToggle': '逐行',
  'bubble.lineFusionTooltip': '多行原文时逐行融合',
  'bubble.groupDisplay': '翻译怎么显示',
  'bubble.displayOriginal': '只看原文',
  'bubble.displayTranslation': '覆盖原文',
  'bubble.displayContrast': '对照',
  'bubble.groupContrast': '对照',
  'bubble.styleEmphasizeOrig': '高亮原文',
  'bubble.styleEmphasizeTrans': '高亮翻译',
  'bubble.groupModels': '模型',
  'bubble.superFineBtn': '精翻此文',
  'bubble.superFineCancel': '取消精翻',
};

const EN: Dict = {
  'cta.translateNow': 'Translate now with X-Speed',
  'cta.cancel': 'Cancel',
  'cta.retry': 'Translate again',
  'cta.retryFail': 'Retry translation',

  'bubble.enableTranslation': 'Translate',
  'bubble.dict': 'Dict',
  'bubble.dictTooltip': 'Smart dictionary for hard words in English text',
  'bubble.lineFusionToggle': 'Per line',
  'bubble.lineFusionTooltip': 'Fuse line-by-line for multi-line source',
  // 气球空间窄：3 按钮分段 + 2 按钮分段都得挤进 ~280px 面板。
  // DISPLAY / CONTRAST 组标题本身已经区分了语义，按钮只用名词即可。
  'bubble.groupDisplay': 'Display',
  'bubble.displayOriginal': 'Original',
  'bubble.displayTranslation': 'Translated',
  'bubble.displayContrast': 'Both',
  'bubble.groupContrast': 'Contrast',
  'bubble.styleEmphasizeOrig': 'Original',
  'bubble.styleEmphasizeTrans': 'Translated',
  'bubble.groupModels': 'Model',
  'bubble.superFineBtn': 'Deep translate',
  'bubble.superFineCancel': 'Cancel',
};

const ZH_TW: Dict = {
  'cta.translateNow': '立即 X 光速翻譯',
  'cta.cancel': '取消翻譯',
  'cta.retry': '重新翻譯',
  'cta.retryFail': '重試翻譯',

  'bubble.enableTranslation': '開啟翻譯',
  'bubble.dict': '字典',
  'bubble.dictTooltip': '智慧字典（英文原文生僻詞）',
  'bubble.lineFusionToggle': '逐行',
  'bubble.lineFusionTooltip': '多行原文時逐行融合',
  'bubble.groupDisplay': '翻譯怎麼顯示',
  'bubble.displayOriginal': '只看原文',
  'bubble.displayTranslation': '覆蓋原文',
  'bubble.displayContrast': '對照',
  'bubble.groupContrast': '對照',
  'bubble.styleEmphasizeOrig': '強調原文',
  'bubble.styleEmphasizeTrans': '強調譯文',
  'bubble.groupModels': '模型',
  'bubble.superFineBtn': '精翻此文',
  'bubble.superFineCancel': '取消精翻',
};

const JA: Dict = {
  'cta.translateNow': '今すぐ X 光速翻訳',
  'cta.cancel': '翻訳を中止',
  'cta.retry': '再翻訳',
  'cta.retryFail': '翻訳を再試行',

  'bubble.enableTranslation': '翻訳を有効化',
  'bubble.dict': '辞典',
  'bubble.dictTooltip': '英語原文の難語辞典',
  'bubble.lineFusionToggle': '行ごと',
  'bubble.lineFusionTooltip': '複数行原文を行ごとに融合',
  'bubble.groupDisplay': '表示方法',
  'bubble.displayOriginal': '原文のみ',
  'bubble.displayTranslation': '原文を置換',
  'bubble.displayContrast': '対照',
  'bubble.groupContrast': '対照',
  'bubble.styleEmphasizeOrig': '原文を強調',
  'bubble.styleEmphasizeTrans': '訳文を強調',
  'bubble.groupModels': 'モデル',
  'bubble.superFineBtn': '本文を精翻訳',
  'bubble.superFineCancel': '精翻訳を中止',
};

const KO: Dict = {
  'cta.translateNow': '지금 X 광속 번역',
  'cta.cancel': '번역 취소',
  'cta.retry': '다시 번역',
  'cta.retryFail': '번역 재시도',

  'bubble.enableTranslation': '번역 켜기',
  'bubble.dict': '사전',
  'bubble.dictTooltip': '영문 원본 어려운 단어 사전',
  'bubble.lineFusionToggle': '줄 단위',
  'bubble.lineFusionTooltip': '다중 행 원문을 줄 단위로 융합',
  'bubble.groupDisplay': '표시 방식',
  'bubble.displayOriginal': '원문만',
  'bubble.displayTranslation': '원문 교체',
  'bubble.displayContrast': '대조',
  'bubble.groupContrast': '대조',
  'bubble.styleEmphasizeOrig': '원문 강조',
  'bubble.styleEmphasizeTrans': '번역문 강조',
  'bubble.groupModels': '모델',
  'bubble.superFineBtn': '본문 정밀 번역',
  'bubble.superFineCancel': '정밀 번역 취소',
};

const MESSAGES: Record<UiLang, Dict> = {
  'zh-CN': ZH_CN,
  'zh-TW': ZH_TW,
  'en': EN,
  'ja': JA,
  'ko': KO,
};

/**
 * 按 key 查文案。Fallback 链：lang → en → zh-CN → key 本身。
 * 未翻译的条目不会抛错；返回 key 便于人眼定位遗漏项。
 */
export function t(key: string, lang: string): string {
  const code = (MESSAGES[lang as UiLang] ? lang : 'en') as UiLang;
  return (
    MESSAGES[code][key] ??
    MESSAGES['en'][key] ??
    MESSAGES['zh-CN'][key] ??
    key
  );
}

// 向后兼容的 CTA helpers —— 老 callers 继续可用；新代码用 t() 统一
export const ctaTranslateNow = (lang: string) => t('cta.translateNow', lang);
export const ctaCancel = (lang: string) => t('cta.cancel', lang);
export const ctaRetry = (lang: string) => t('cta.retry', lang);
export const ctaRetryFail = (lang: string) => t('cta.retryFail', lang);
