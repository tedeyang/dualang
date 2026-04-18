const ERROR_STATE_KEY = 'dualang_error_v1';

export async function reportFatalError(message: string, baseUrl?: string) {
  await chrome.storage.local.set({
    [ERROR_STATE_KEY]: { message, baseUrl, ts: Date.now() }
  });
  chrome.action.setBadgeText({ text: '!' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#f4212e' }).catch(() => {});
}

export async function clearErrorState() {
  await chrome.storage.local.remove(ERROR_STATE_KEY);
  chrome.action.setBadgeText({ text: '' }).catch(() => {});
}
