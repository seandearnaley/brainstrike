import type { StorageAdapter } from '@brainstrike/storage';
import { WebStorageAdapter } from '@brainstrike/storage';
import * as React from 'react';

type Theme = 'dark' | 'light' | 'system';

interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageAdapter?: StorageAdapter;
  storageKey?: string;
}

interface ThemeProviderState {
  setTheme: (theme: Theme) => void;
  theme: Theme;
}

const ThemeProviderContext = React.createContext<ThemeProviderState | undefined>(undefined);

export function ThemeProvider({
  children,
  defaultTheme = 'system',
  storageKey = 'ui-theme',
  storageAdapter,
  ...props
}: ThemeProviderProps) {
  const [theme, setTheme] = React.useState<Theme>(defaultTheme);
  const [mounted, setMounted] = React.useState(false);

  const adapter = React.useMemo(() => storageAdapter ?? new WebStorageAdapter(), [storageAdapter]);

  // Only access storage after component is mounted (client-side)
  React.useEffect(() => {
    async function loadTheme() {
      const savedTheme = (await adapter.getItem(storageKey)) as Theme | null;
      if (savedTheme) {
        setTheme(savedTheme);
      }
      setMounted(true);
    }

    void loadTheme();
  }, [adapter, storageKey]);

  React.useEffect(() => {
    const root = window.document.documentElement;

    root.classList.remove('light', 'dark');

    if (theme === 'system') {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';

      root.classList.add(systemTheme);
      return;
    }

    root.classList.add(theme);
  }, [theme]);

  const setAndStoreTheme = React.useCallback(
    (newTheme: Theme) => {
      void adapter.setItem(storageKey, newTheme);
      setTheme(newTheme);
    },
    [adapter, storageKey]
  );

  const value = React.useMemo(
    () => ({
      theme,
      setTheme: setAndStoreTheme,
    }),
    [theme, setAndStoreTheme]
  );

  // Prevent flash of incorrect theme
  if (!mounted) {
    return null;
  }

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export const useTheme = () => {
  const context = React.useContext(ThemeProviderContext);

  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }

  return context;
};
