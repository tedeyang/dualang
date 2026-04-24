/**
 * popup DOM 上的 i18n 应用助手。
 *
 * 静态元素在 popup.html 里用 `data-i18n="key"` 标记；providers-tab 等动态渲染
 * 时也把 `data-i18n` 写进生成的 innerHTML，然后调 `applyI18n()` 一次性刷新。
 *
 * 语言状态走模块级单例：popup/index.ts 初始化时 `setUiLang(detected)`；
 * 用户切换时再次调用。providers-tab 只需要 `applyI18n()`（读当前 lang）。
 */

import { detectDefaultUiLang, type UiLang } from '../shared/i18n';
import { t } from '../shared/i18n-popup';

let currentLang: UiLang = detectDefaultUiLang();

export function setUiLang(lang: UiLang): void {
  currentLang = lang;
  try {
    document.documentElement.setAttribute('lang', lang);
  } catch {}
}

export function getUiLang(): UiLang {
  return currentLang;
}

/**
 * 扫描 root 下所有 `data-i18n="key"` 元素替换 textContent。
 *  - option 元素用 `.text` 赋值（保留 value）
 *  - 其它元素用 textContent（原子替换，不保留子节点；所以翻译字符串不要含 HTML）
 * 额外支持属性型 key（需要翻译 title / placeholder / aria-label 时）：
 *  - `data-i18n-title="key"` / `data-i18n-placeholder="key"` / `data-i18n-aria-label="key"`
 */
export function applyI18n(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (!key) return;
    const s = t(key, currentLang);
    if (el instanceof HTMLOptionElement) el.text = s;
    else el.textContent = s;
  });
  const attrMap: Array<[string, string]> = [
    ['data-i18n-title', 'title'],
    ['data-i18n-placeholder', 'placeholder'],
    ['data-i18n-aria-label', 'aria-label'],
  ];
  for (const [dataAttr, targetAttr] of attrMap) {
    root.querySelectorAll<HTMLElement>(`[${dataAttr}]`).forEach((el) => {
      const key = el.getAttribute(dataAttr);
      if (key) el.setAttribute(targetAttr, t(key, currentLang));
    });
  }
}

/** 便捷：拿当前语言查一个 key */
export function tr(key: string): string {
  return t(key, currentLang);
}
