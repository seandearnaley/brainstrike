import { createLogger } from '@brainstrike/logging';
import { getErrorMessage } from '@brainstrike/utils/error-utils';
import { AlertTriangle, RotateCw } from 'lucide-react';
import * as React from 'react';
// Relative imports, never the `@brainstrike/ui` barrel: the barrel re-exports
// this module, so importing it here would close a source cycle (BST-890).
import { Button } from './button';
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
  isCodeFontId,
  isCodeThemeId,
  isFontId,
  isThemeId,
  type ThemeId,
} from './themes';
import { toast } from './use-toast';

const logger = createLogger('ThemeProvider');

export type ThemeMode = 'dark' | 'light' | 'system';

const THEME_MODES: ReadonlySet<string> = new Set(['dark', 'light', 'system']);

function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && THEME_MODES.has(value);
}

export interface ThemeStorageAdapter {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
}

interface ThemeProviderProps {
  children: React.ReactNode;
  /** Light, dark or system. Persisted under `storageKey`. */
  defaultMode?: ThemeMode;
  /** Palette id. Persisted under `themeStorageKey`. */
  defaultTheme?: ThemeId;
  storageAdapter: ThemeStorageAdapter;
  /**
   * Key of the saved mode. The font, code font and code theme are saved beside
   * it under `<storageKey>-font`, `<storageKey>-code-font` and
   * `<storageKey>-code-theme`.
   */
  storageKey?: string;
  themeStorageKey?: string;
}

/** The choices beside the mode, each saved under its own key. */
export interface Appearance {
  readonly codeFont: CodeFontId;
  readonly codeTheme: CodeThemeId;
  readonly font: FontId;
  readonly theme: ThemeId;
}

type AppearanceKey = keyof Appearance;

const APPEARANCE_VALIDATORS: {
  readonly [Key in AppearanceKey]: (value: unknown) => value is Appearance[Key];
} = {
  codeFont: isCodeFontId,
  codeTheme: isCodeThemeId,
  font: isFontId,
  theme: isThemeId,
};

const APPEARANCE_KEYS = Object.keys(APPEARANCE_VALIDATORS) as AppearanceKey[];

/**
 * Copies one saved choice into `restored`. A value this build does not know (a
 * palette removed in a later release, say) keeps the default and says so; it is
 * not a failed read.
 */
function restoreChoice<Key extends AppearanceKey>(
  restored: Partial<Appearance>,
  key: Key,
  saved: string | null | undefined,
  storageKey: string
): void {
  if (!saved) {
    return;
  }
  if (APPEARANCE_VALIDATORS[key](saved)) {
    restored[key] = saved;
    return;
  }
  logger.warn('Ignoring an unknown saved appearance choice', { storageKey, value: saved });
}

interface ThemeProviderState extends Appearance {
  mode: ThemeMode;
  setCodeFont: (codeFont: CodeFontId) => void;
  setCodeTheme: (codeTheme: CodeThemeId) => void;
  setFont: (font: FontId) => void;
  setMode: (mode: ThemeMode) => void;
  setTheme: (theme: ThemeId) => void;
}

type ThemeLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'ready' }
  | { readonly error: unknown; readonly status: 'failed' };

const LOADING: ThemeLoad = { status: 'loading' };
const READY: ThemeLoad = { status: 'ready' };

const ThemeProviderContext = React.createContext<ThemeProviderState | undefined>(undefined);

export function ThemeProvider({
  children,
  defaultMode = 'system',
  defaultTheme = DEFAULT_THEME,
  storageKey = 'ui-theme',
  themeStorageKey = 'ui-theme-palette',
  storageAdapter,
}: ThemeProviderProps) {
  const [mode, setModeState] = React.useState<ThemeMode>(defaultMode);
  const [appearance, setAppearanceState] = React.useState<Appearance>(() => ({
    codeFont: DEFAULT_CODE_FONT,
    codeTheme: DEFAULT_CODE_THEME,
    font: DEFAULT_FONT,
    theme: defaultTheme,
  }));
  const appearanceStorageKeys = React.useMemo<Readonly<Record<AppearanceKey, string>>>(
    () => ({
      codeFont: `${storageKey}-code-font`,
      codeTheme: `${storageKey}-code-theme`,
      font: `${storageKey}-font`,
      theme: themeStorageKey,
    }),
    [storageKey, themeStorageKey]
  );
  const [load, setLoad] = React.useState<ThemeLoad>(LOADING);
  const [attempt, setAttempt] = React.useState(0);

  // Only access storage after component is mounted (client-side). A failed read
  // stops here with a visible failure (BST-1731): it never substitutes the
  // default theme on its own, and it never writes over the saved preference.
  // A saved value this build does not know (a palette removed in a later
  // release, say) keeps the default and says so; it is not a failed read.
  React.useEffect(() => {
    let current = true;
    Promise.all([
      storageAdapter.getItem(storageKey),
      Promise.all(APPEARANCE_KEYS.map((key) => storageAdapter.getItem(appearanceStorageKeys[key]))),
    ]).then(
      ([savedMode, savedAppearance]) => {
        if (!current) {
          return;
        }
        if (savedMode) {
          if (isThemeMode(savedMode)) {
            setModeState(savedMode);
          } else {
            logger.warn('Ignoring an unknown saved theme mode', { storageKey, value: savedMode });
          }
        }
        const restored: Partial<Appearance> = {};
        APPEARANCE_KEYS.forEach((key, index) => {
          restoreChoice(restored, key, savedAppearance[index], appearanceStorageKeys[key]);
        });
        setAppearanceState((previous) => ({ ...previous, ...restored }));
        setLoad(READY);
      },
      (error: unknown) => {
        if (!current) {
          return;
        }
        logger.error('Reading the saved theme preference failed', {
          attempt,
          error,
          storageKey,
          storageKeys: appearanceStorageKeys,
        });
        setLoad({ error, status: 'failed' });
      }
    );
    return () => {
      current = false;
    };
  }, [appearanceStorageKeys, attempt, storageAdapter, storageKey]);

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
  const { codeFont, codeTheme, font, theme } = appearance;
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

  const store = React.useCallback(
    (key: string, value: string, detail: Record<string, string>) => {
      storageAdapter.setItem(key, value).catch((error: unknown) => {
        logger.error('Saving the theme preference failed', { error, storageKey: key, ...detail });
        toast({
          description: 'The theme changed for this session, but it could not be saved.',
          title: 'Theme not saved',
          variant: 'destructive',
        });
      });
    },
    [storageAdapter]
  );

  const setMode = React.useCallback(
    (next: ThemeMode) => {
      store(storageKey, next, { mode: next });
      setModeState(next);
    },
    [store, storageKey]
  );

  const setAppearance = React.useCallback(
    <Key extends AppearanceKey>(key: Key, next: Appearance[Key]) => {
      store(appearanceStorageKeys[key], next, { [key]: next });
      setAppearanceState((previous) => ({ ...previous, [key]: next }));
    },
    [appearanceStorageKeys, store]
  );

  const value = React.useMemo(
    () => ({
      ...appearance,
      mode,
      setCodeFont: (next: CodeFontId) => setAppearance('codeFont', next),
      setCodeTheme: (next: CodeThemeId) => setAppearance('codeTheme', next),
      setFont: (next: FontId) => setAppearance('font', next),
      setMode,
      setTheme: (next: ThemeId) => setAppearance('theme', next),
    }),
    [appearance, mode, setAppearance, setMode]
  );

  const retryLoad = React.useCallback(() => {
    setLoad(LOADING);
    setAttempt((previous) => previous + 1);
  }, []);

  const continueWithDefault = React.useCallback(() => {
    setLoad(READY);
  }, []);

  if (load.status === 'failed') {
    return (
      <ThemeLoadFailure
        defaultMode={defaultMode}
        error={load.error}
        onContinue={continueWithDefault}
        onRetry={retryLoad}
      />
    );
  }

  // Prevent flash of incorrect theme
  if (load.status === 'loading') {
    return null;
  }

  return <ThemeProviderContext.Provider value={value}>{children}</ThemeProviderContext.Provider>;
}

/**
 * Shown in place of the app when the saved theme cannot be read. "Try again"
 * re-reads storage; "Continue" opens the app on the default theme for this
 * session only, leaving the saved preference untouched.
 */
function ThemeLoadFailure({
  defaultMode,
  error,
  onContinue,
  onRetry,
}: {
  readonly defaultMode: ThemeMode;
  readonly error: unknown;
  readonly onContinue: () => void;
  readonly onRetry: () => void;
}): React.ReactElement {
  return (
    <div
      className="bg-background text-foreground flex h-screen flex-col items-center justify-center gap-3 p-6 text-center"
      data-slot="theme-load-failure"
      role="alert"
    >
      <AlertTriangle aria-hidden="true" className="text-destructive size-6" />
      <h1 className="text-lg font-semibold">Your theme preference couldn't be read</h1>
      <p className="text-muted-foreground max-w-md text-sm">
        The app reads your saved theme before it opens, and reading it from storage failed. Your
        saved preference has not been changed.
      </p>
      <p className="text-muted-foreground max-w-md font-mono text-xs break-words">
        {getErrorMessage(error)}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button onClick={onRetry} size="sm" type="button">
          <RotateCw aria-hidden="true" />
          Try again
        </Button>
        <Button onClick={onContinue} size="sm" type="button" variant="outline">
          Continue with the {defaultMode} theme
        </Button>
      </div>
      <p className="text-muted-foreground max-w-md text-xs">
        Continuing uses the {defaultMode} theme for this session and keeps your saved preference.
      </p>
    </div>
  );
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
