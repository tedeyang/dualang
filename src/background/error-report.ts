/** 致命错误状态在 chrome.storage.local 里的键名 */
const ERROR_STATE_KEY = 'dualang_error_v1';

/**
 * 记录致命错误并显示红色 badge 提示。
 * popup 打开时会读取此状态展示错误横幅；保存设置时自动清除。
 */
export async function reportFatalError(message: string, baseUrl?: string) {
  await chrome.storage.local.set({
    [ERROR_STATE_KEY]: { message, baseUrl, ts: Date.now() }
  });
  chrome.action.setBadgeText({ text: '!' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#f4212e' }).catch(() => {});
}

/** 清除错误状态并去掉 badge 红点 */
export async function clearErrorState() {
  await chrome.storage.local.remove(ERROR_STATE_KEY);
  chrome.action.setBadgeText({ text: '' }).catch(() => {});
}
