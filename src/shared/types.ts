// ========== Content ↔ Background 消息契约 ==========

export interface TranslatePayload {
  texts?: string[];
  text?: string;
  priority?: number;
}

export interface TranslateRequest {
  action: 'translate';
  payload: TranslatePayload;
}

export interface ToggleMessage {
  action: 'toggle';
  enabled: boolean;
}

export type RuntimeMessage = TranslateRequest | ToggleMessage;

export interface TranslateResponseData {
  translations: (string | null)[];
  translated?: string;
  fromCache?: boolean;
}

export interface TranslateResponse {
  success: boolean;
  data?: TranslateResponseData;
  error?: string;
}

// ========== 共享工具 ==========

/** 规范化文本：压缩空白、换行，用于 cacheKey 和文本比对 */
export function normalizeText(text: string): string {
  return text
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
