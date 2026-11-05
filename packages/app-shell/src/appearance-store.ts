import { persistDurable } from '@brainstrike/storage';
import {
  isCodeFontId,
  isCodeFontSize,
  isCodeThemeId,
  isCustomFontName,
  isFontId,
  isMotionPreference,
  isThemeId,
  isTranscriptTextSize,
  isTranscriptWidth,
  type SavedAppearance,
  type ThemeMode,
} from '@brainstrike/ui';
import { create } from 'zustand';

const THEME_MODES: ReadonlySet<string> = new Set<ThemeMode>(['dark', 'light', 'system']);

function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && THEME_MODES.has(value);
}

export const APPEARANCE_STORAGE_KEY = 'brainstrike:ui-appearance';

const VALIDATORS: { readonly [Key in keyof SavedAppearance]-?: (value: unknown) => boolean } = {
  codeFont: isCodeFontId,
  codeFontSize: isCodeFontSize,
  codeTheme: isCodeThemeId,
  customCodeFont: isCustomFontName,
  font: isFontId,
  mode: isThemeMode,
  motion: isMotionPreference,
  theme: isThemeId,
  transcriptTextSize: isTranscriptTextSize,
  transcriptWidth: isTranscriptWidth,
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
 * The app's appearance choices: renderer-only view state (`persistDurable`), read
 * synchronously as the store is created, so the first render already has them. `ThemeProvider` receives them as props.
 */
export const useAppearanceStore = create<SavedAppearance>()(
  persistDurable(APPEARANCE_STORAGE_KEY, () => ({}), {
    merge: (saved, current) => ({ ...current, ...knownChoices(saved) }),
    version: 1,
  })
);

export const chooseAppearance = (choice: SavedAppearance): void => {
  useAppearanceStore.setState(choice);
};
