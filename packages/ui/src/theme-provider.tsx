import * as React from 'react';
// Relative imports, never the `@brainstrike/ui` barrel: the barrel re-exports
// this module, so importing it here would close a source cycle (BST-890).
import {
  type CodeFontId,
  type CodeFontSize,
  type CodeThemeChoice,
  type CodeThemeId,
  codeFontStack,
  DEFAULT_CODE_FONT,
  DEFAULT_CODE_THEME,
  DEFAULT_FONT,
  DEFAULT_MOTION,
  DEFAULT_TERMINAL_FONT_SIZE,
  DEFAULT_THEME,
  DEFAULT_TRANSCRIPT_TEXT_SIZE,
  DEFAULT_TRANSCRIPT_WIDTH,
  type FontId,
  fontFamily,
  type MotionPreference,
  type ThemeId,
  type TranscriptTextSize,
  type TranscriptWidth,
} from './themes';

export type ThemeMode = 'dark' | 'light' | 'system';

/**
 * The appearance choices the user made. A choice left unset follows the
 * provider's default, so only what the user picked needs saving.
 */
export interface SavedAppearance {
  readonly codeFont?: CodeFontId;
  /** Unset keeps each code surface's own size; `undefined` clears a choice. */
  readonly codeFontSize?: CodeFontSize | undefined;
  readonly codeThemeDark?: CodeThemeId;
  readonly codeThemeLight?: CodeThemeId;
  /** An installed font named by the user, tried before `codeFont`; `undefined` clears it. */
  readonly customCodeFont?: string | undefined;
  readonly font?: FontId;
  readonly mode?: ThemeMode;
  readonly motion?: MotionPreference;
  readonly theme?: ThemeId;
  readonly transcriptTextSize?: TranscriptTextSize;
  readonly transcriptWidth?: TranscriptWidth;
}

interface ThemeProviderProps {
  /**
   * The saved choices, owned by the app. Without it the provider keeps the
   * choices for this session only.
   */
  appearance?: SavedAppearance;
  children: React.ReactNode;
  /** Light, dark or system, until the user picks one. */
  defaultMode?: ThemeMode;
  /** Palette id, until the user picks one. */
  defaultTheme?: ThemeId;
  /** Called with each choice the user makes, for the app to save. */
  onAppearanceChange?: (choice: SavedAppearance) => void;
}

/** The choices beside the mode. */
export interface Appearance {
  readonly codeFont: CodeFontId;
  readonly codeFontSize: CodeFontSize | null;
  readonly codeThemeDark: CodeThemeId;
  readonly codeThemeLight: CodeThemeId;
  readonly customCodeFont: string;
  readonly font: FontId;
  readonly motion: MotionPreference;
  readonly theme: ThemeId;
  readonly transcriptTextSize: TranscriptTextSize;
  readonly transcriptWidth: TranscriptWidth;
}

interface ThemeProviderState extends Appearance {
  mode: ThemeMode;
  setCodeFont: (codeFont: CodeFontId) => void;
  /** `null` goes back to each surface's own size. */
  setCodeFontSize: (codeFontSize: CodeFontSize | null) => void;
  setCodeThemeDark: (codeTheme: CodeThemeId) => void;
  setCodeThemeLight: (codeTheme: CodeThemeId) => void;
  /** An empty name goes back to the bundled code font alone. */
  setCustomCodeFont: (customCodeFont: string) => void;
  setFont: (font: FontId) => void;
  setMode: (mode: ThemeMode) => void;
  setMotion: (motion: MotionPreference) => void;
  setTheme: (theme: ThemeId) => void;
  setTranscriptTextSize: (transcriptTextSize: TranscriptTextSize) => void;
  setTranscriptWidth: (transcriptWidth: TranscriptWidth) => void;
}

const ThemeProviderContext = React.createContext<ThemeProviderState | undefined>(undefined);

/**
 * Applies the appearance to the document. The app owns where the choices are
 * saved: it passes them in `appearance` and saves what `onAppearanceChange`
 * reports, so this shared provider never touches a preference store.
 */
export function ThemeProvider({
  appearance,
  children,
  defaultMode = 'system',
  defaultTheme = DEFAULT_THEME,
  onAppearanceChange,
}: ThemeProviderProps) {
  const [sessionAppearance, setSessionAppearance] = React.useState<SavedAppearance>({});
  const saved = appearance ?? sessionAppearance;
  const choose = (choice: SavedAppearance) => {
    if (onAppearanceChange) {
      onAppearanceChange(choice);
      return;
    }
    setSessionAppearance((previous) => ({ ...previous, ...choice }));
  };
  const mode = saved.mode ?? defaultMode;
  const theme = saved.theme ?? defaultTheme;
  const font = saved.font ?? DEFAULT_FONT;
  const codeFont = saved.codeFont ?? DEFAULT_CODE_FONT;
  const codeThemeLight = saved.codeThemeLight ?? DEFAULT_CODE_THEME;
  const codeThemeDark = saved.codeThemeDark ?? DEFAULT_CODE_THEME;
  const codeFontSize = saved.codeFontSize ?? null;
  const customCodeFont = saved.customCodeFont ?? '';
  const motion = saved.motion ?? DEFAULT_MOTION;
  const transcriptTextSize = saved.transcriptTextSize ?? DEFAULT_TRANSCRIPT_TEXT_SIZE;
  const transcriptWidth = saved.transcriptWidth ?? DEFAULT_TRANSCRIPT_WIDTH;

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

  // The palette is a `data-theme` attribute and the code themes
  // `data-code-theme-light`/`-dark`; the light/dark class picks which applies.
  React.useEffect(() => {
    window.document.documentElement.dataset['theme'] = theme;
  }, [theme]);

  React.useEffect(() => {
    const { dataset } = window.document.documentElement;
    dataset['codeThemeLight'] = codeThemeLight;
    dataset['codeThemeDark'] = codeThemeDark;
  }, [codeThemeLight, codeThemeDark]);

  // Fonts replace the stacks Tailwind's `font-sans`/`font-mono` read, so every
  // surface that uses them (and CodeMirror, which reads `--font-mono`) follows.
  React.useEffect(() => {
    window.document.documentElement.style.setProperty('--font-sans', fontFamily(font));
  }, [font]);

  React.useEffect(() => {
    window.document.documentElement.style.setProperty(
      '--font-mono',
      codeFontStack(codeFont, customCodeFont)
    );
  }, [codeFont, customCodeFont]);

  // Code surfaces read `var(--code-font-size, <their own size>)`, so removing
  // the property puts each one back on its built-in size.
  React.useEffect(() => {
    const { style } = window.document.documentElement;
    if (codeFontSize === null) {
      style.removeProperty('--code-font-size');
      style.removeProperty('--code-line-height');
      return;
    }
    style.setProperty('--code-font-size', `${codeFontSize}px`);
    // For surfaces that set a fixed line height (the diff renderer).
    style.setProperty('--code-line-height', `${Math.round(codeFontSize * 1.55)}px`);
  }, [codeFontSize]);

  React.useEffect(() => {
    const { dataset } = window.document.documentElement;
    dataset['transcriptSize'] = transcriptTextSize;
    dataset['transcriptWidth'] = transcriptWidth;
  }, [transcriptTextSize, transcriptWidth]);

  // `system` leaves motion to the device's `prefers-reduced-motion`; `reduced`
  // adds `data-motion="reduce"`, which the same reduced-motion rules also match.
  React.useEffect(() => {
    const root = window.document.documentElement;
    if (motion === 'reduced') {
      root.dataset['motion'] = 'reduce';
      return;
    }
    root.removeAttribute('data-motion');
  }, [motion]);

  const value: ThemeProviderState = {
    codeFont,
    codeFontSize,
    codeThemeDark,
    codeThemeLight,
    customCodeFont,
    font,
    mode,
    motion,
    setCodeFont: (next) => choose({ codeFont: next }),
    // Clearing a choice saves `undefined`, which the store drops, so the
    // choice follows the default again.
    setCodeFontSize: (next) => choose({ codeFontSize: next ?? undefined }),
    setCodeThemeDark: (next) => choose({ codeThemeDark: next }),
    setCodeThemeLight: (next) => choose({ codeThemeLight: next }),
    setCustomCodeFont: (next) => choose({ customCodeFont: next || undefined }),
    setFont: (next) => choose({ font: next }),
    setMode: (next) => choose({ mode: next }),
    setMotion: (next) => choose({ motion: next }),
    setTheme: (next) => choose({ theme: next }),
    setTranscriptTextSize: (next) => choose({ transcriptTextSize: next }),
    setTranscriptWidth: (next) => choose({ transcriptWidth: next }),
    theme,
    transcriptTextSize,
    transcriptWidth,
  };

  return <ThemeProviderContext.Provider value={value}>{children}</ThemeProviderContext.Provider>;
}

/**
 * The code themes chosen for light and dark mode, for code blocks and diffs. A
 * code block can render outside the app's provider (an isolated surface or a
 * component test); there it uses the default code theme, as the CodeMirror
 * tokens do with no `data-code-theme-*`.
 */
export function useCodeTheme(): CodeThemeChoice {
  const context = React.useContext(ThemeProviderContext);
  return {
    dark: context?.codeThemeDark ?? DEFAULT_CODE_THEME,
    light: context?.codeThemeLight ?? DEFAULT_CODE_THEME,
  };
}

/** Light, dark or system, for code surfaces; outside the provider it follows the system. */
export function useThemeMode(): ThemeMode {
  return React.useContext(ThemeProviderContext)?.mode ?? 'system';
}

/**
 * The code font for surfaces that cannot read CSS, such as the terminal's
 * canvas. Outside the provider it is the default font at the default size.
 */
export function useCodeFont(): { readonly family: string; readonly size: number } {
  const context = React.useContext(ThemeProviderContext);
  return {
    family: codeFontStack(context?.codeFont ?? DEFAULT_CODE_FONT, context?.customCodeFont ?? ''),
    size: context?.codeFontSize ?? DEFAULT_TERMINAL_FONT_SIZE,
  };
}

export const useTheme = () => {
  const context = React.useContext(ThemeProviderContext);

  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }

  return context;
};
