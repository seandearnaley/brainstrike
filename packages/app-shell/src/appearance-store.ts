import {
  isCodeFontId,
  isCodeThemeId,
  isFontId,
  isThemeId,
  type SavedAppearance,
  type ThemeMode,
} from '@brainstrike/ui';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const THEME_MODES: ReadonlySet<string> = new Set<ThemeMode>(['dark', 'light', 'system']);

function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && THEME_MODES.has(value);
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

/**
 * The app's appearance choices: renderer-only view state, saved in this renderer's
 * `localStorage` (zustand's default) and read synchronously as the store is created,
 * so the first render already has them. `ThemeProvider` receives them as props.
 */
export const useAppearanceStore = create<SavedAppearance>()(
  persist(() => ({}), {
    merge: (saved, current) => ({ ...current, ...knownChoices(saved) }),
    name: APPEARANCE_STORAGE_KEY,
    version: 1,
  })
);

export const chooseAppearance = (choice: SavedAppearance): void => {
  useAppearanceStore.setState(choice);
};
