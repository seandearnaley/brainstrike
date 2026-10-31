import * as React from 'react';
import { type SavedAppearance, type ThemeMode, useAppearanceStore } from './appearance-store';
// Relative imports, never the `@brainstrike/ui` barrel: the barrel re-exports
// this module, so importing it here would close a source cycle (BST-890).
import {
  type CodeFontId,
  type CodeThemeId,
  codeFontFamily,
  DEFAULT_CODE_FONT,
  DEFAULT_CODE_THEME,
  DEFAULT_FONT,
  DEFAULT_THEME,
  type FontId,
  fontFamily,
  type ThemeId,
} from './themes';

export type { ThemeMode } from './appearance-store';

interface ThemeProviderProps {
  children: React.ReactNode;
  /** Light, dark or system, until the user picks one. */
  defaultMode?: ThemeMode;
  /** Palette id, until the user picks one. */
  defaultTheme?: ThemeId;
}

/** The choices beside the mode. */
export interface Appearance {
  readonly codeFont: CodeFontId;
  readonly codeTheme: CodeThemeId;
  readonly font: FontId;
  readonly theme: ThemeId;
}

interface ThemeProviderState extends Appearance {
  mode: ThemeMode;
  setCodeFont: (codeFont: CodeFontId) => void;
  setCodeTheme: (codeTheme: CodeThemeId) => void;
  setFont: (font: FontId) => void;
  setMode: (mode: ThemeMode) => void;
  setTheme: (theme: ThemeId) => void;
}

const ThemeProviderContext = React.createContext<ThemeProviderState | undefined>(undefined);

const choose = (choice: SavedAppearance) => useAppearanceStore.setState(choice);

/**
 * Applies the saved appearance (`useAppearanceStore`, in `localStorage`) to the
 * document. The store reads `localStorage` synchronously as it is created, so
 * the first render already has the saved choices.
 */
export function ThemeProvider({
  children,
  defaultMode = 'system',
  defaultTheme = DEFAULT_THEME,
}: ThemeProviderProps) {
  const saved = useAppearanceStore();
  const mode = saved.mode ?? defaultMode;
  const theme = saved.theme ?? defaultTheme;
  const font = saved.font ?? DEFAULT_FONT;
  const codeFont = saved.codeFont ?? DEFAULT_CODE_FONT;
  const codeTheme = saved.codeTheme ?? DEFAULT_CODE_THEME;

  React.useEffect(() => {
    const root = window.document.documentElement;

    root.classList.remove('light', 'dark');

    if (mode === 'system') {
      const systemMode = window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';

      root.classList.add(systemMode);
      return;
    }

    root.classList.add(mode);
  }, [mode]);

  // The palette is a `data-theme` attribute and the code theme a
  // `data-code-theme` attribute, both orthogonal to the light/dark class.
  React.useEffect(() => {
    window.document.documentElement.dataset['theme'] = theme;
  }, [theme]);

  React.useEffect(() => {
    window.document.documentElement.dataset['codeTheme'] = codeTheme;
  }, [codeTheme]);

  // Fonts replace the stacks Tailwind's `font-sans`/`font-mono` read, so every
  // surface that uses them (and CodeMirror, which reads `--font-mono`) follows.
  React.useEffect(() => {
    window.document.documentElement.style.setProperty('--font-sans', fontFamily(font));
  }, [font]);

  React.useEffect(() => {
    window.document.documentElement.style.setProperty('--font-mono', codeFontFamily(codeFont));
  }, [codeFont]);

  const value: ThemeProviderState = {
    codeFont,
    codeTheme,
    font,
    mode,
    setCodeFont: (next) => choose({ codeFont: next }),
    setCodeTheme: (next) => choose({ codeTheme: next }),
    setFont: (next) => choose({ font: next }),
    setMode: (next) => choose({ mode: next }),
    setTheme: (next) => choose({ theme: next }),
    theme,
  };

  return <ThemeProviderContext.Provider value={value}>{children}</ThemeProviderContext.Provider>;
}

/**
 * The current code theme, for code blocks. A code block can render outside
 * the app's provider (an isolated surface or a component test); there it uses
 * the default code theme, as the CodeMirror tokens do with no `data-code-theme`.
 */
export function useCodeTheme(): CodeThemeId {
  return React.useContext(ThemeProviderContext)?.codeTheme ?? DEFAULT_CODE_THEME;
}

export const useTheme = () => {
  const context = React.useContext(ThemeProviderContext);

  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }

  return context;
};
