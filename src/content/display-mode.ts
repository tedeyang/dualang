import type { DisplayMode } from '../shared/types';

export const VALID_DISPLAY_MODES: DisplayMode[] = ['append', 'translation-only', 'inline', 'bilingual'];

/**
 * 将 storage 里可能为 unknown 的 displayMode 归一化；legacy bilingualMode=true
 * （old 布尔字段，无 displayMode）→ 'inline'；其余默认 'append'。
 */
export function normalizeDisplayMode(mode: unknown, legacyBilingual: unknown): DisplayMode {
  if (typeof mode === 'string' && (VALID_DISPLAY_MODES as string[]).includes(mode)) {
    return mode as DisplayMode;
  }
  return legacyBilingual ? 'inline' : 'append';
}

export type { DisplayMode };
