import { createLogger } from '@brainstrike/logging';
import * as React from 'react';
import { DEFAULT_THEME, isThemeId, type ThemeId } from './themes';

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
  /** Light/dark/system. Persisted under `storageKey`. */
  defaultMode?: ThemeMode;
  /** Palette id. Persisted under `themeStorageKey`. */
  defaultTheme?: ThemeId;
  storageAdapter: ThemeStorageAdapter;
  storageKey?: string;
  themeStorageKey?: string;
}

interface ThemeProviderState {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  setTheme: (theme: ThemeId) => void;
  theme: ThemeId;
}

const ThemeProviderContext = React.createContext<ThemeProviderState | undefined>(undefined);

export function ThemeProvider({
  children,
  defaultMode = 'system',
  defaultTheme = DEFAULT_THEME,
  storageAdapter,
  storageKey = 'ui-theme',
  themeStorageKey = 'ui-theme-palette',
}: ThemeProviderProps) {
  const [mode, setModeState] = React.useState<ThemeMode>(defaultMode);
  const [theme, setThemeState] = React.useState<ThemeId>(defaultTheme);
  const [mounted, setMounted] = React.useState(false);

  // Storage is async and only reachable after mount (client-side). An unknown
  // persisted value (e.g. a theme removed in a later release) must not blank
  // the app, and must not be silent: it falls back to the default and warns.
  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      const [savedMode, savedTheme] = await Promise.all([
        storageAdapter.getItem(storageKey),
        storageAdapter.getItem(themeStorageKey),
      ]);
      if (cancelled) {
        return;
      }
      if (savedMode !== null) {
        if (isThemeMode(savedMode)) {
          setModeState(savedMode);
        } else {
          logger.warn('Ignoring unknown persisted theme mode', {
            key: storageKey,
            value: savedMode,
          });
        }
      }
      if (savedTheme !== null) {
        if (isThemeId(savedTheme)) {
          setThemeState(savedTheme);
        } else {
          logger.warn('Ignoring unknown persisted theme', {
            key: themeStorageKey,
            value: savedTheme,
          });
        }
      }
      setMounted(true);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [storageAdapter, storageKey, themeStorageKey]);

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

  React.useEffect(() => {
    window.document.documentElement.dataset['theme'] = theme;
  }, [theme]);

  const setMode = React.useCallback(
    (next: ThemeMode) => {
      void storageAdapter.setItem(storageKey, next);
      setModeState(next);
    },
    [storageAdapter, storageKey]
  );

  const setTheme = React.useCallback(
    (next: ThemeId) => {
      void storageAdapter.setItem(themeStorageKey, next);
      setThemeState(next);
    },
    [storageAdapter, themeStorageKey]
  );

  const value = React.useMemo(
    () => ({ mode, setMode, setTheme, theme }),
    [mode, setMode, setTheme, theme]
  );

  // Prevent a flash of the wrong mode/theme before storage has been read.
  if (!mounted) {
    return null;
  }

  return <ThemeProviderContext.Provider value={value}>{children}</ThemeProviderContext.Provider>;
}

export const useTheme = () => {
  const context = React.useContext(ThemeProviderContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};
