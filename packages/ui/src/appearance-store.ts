import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  type CodeFontId,
  type CodeThemeId,
  type FontId,
  isCodeFontId,
  isCodeThemeId,
  isFontId,
  isThemeId,
  type ThemeId,
} from './themes';

export type ThemeMode = 'dark' | 'light' | 'system';

const THEME_MODES: ReadonlySet<string> = new Set(['dark', 'light', 'system']);

function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && THEME_MODES.has(value);
}

/**
 * The appearance choices the user made. A choice left unset follows the
 * provider's default, so only what the user picked is saved.
 */
export interface SavedAppearance {
  readonly codeFont?: CodeFontId;
  readonly codeTheme?: CodeThemeId;
  readonly font?: FontId;
  readonly mode?: ThemeMode;
  readonly theme?: ThemeId;
}

export const APPEARANCE_STORAGE_KEY = 'ui-appearance';

const VALIDATORS: { readonly [Key in keyof SavedAppearance]-?: (value: unknown) => boolean } = {
  codeFont: isCodeFontId,
  codeTheme: isCodeThemeId,
  font: isFontId,
  mode: isThemeMode,
  theme: isThemeId,
};

/**
 * Keeps each saved choice this build knows. A value it does not know (a palette
 * removed in a later release, say) is dropped, so that choice follows the default.
 */
function knownChoices(saved: unknown): SavedAppearance {
  if (!(saved && typeof saved === 'object')) {
    return {};
  }
  const record = saved as Record<string, unknown>;
  const known: Record<string, unknown> = {};
  for (const [key, isKnown] of Object.entries(VALIDATORS)) {
    if (isKnown(record[key])) {
      known[key] = record[key];
    }
  }
  return known as SavedAppearance;
}

/** Renderer-only view state, saved in this renderer's `localStorage` (zustand's default). */
export const useAppearanceStore = create<SavedAppearance>()(
  persist(() => ({}), {
    merge: (saved, current) => ({ ...current, ...knownChoices(saved) }),
    name: APPEARANCE_STORAGE_KEY,
    version: 1,
  })
);
