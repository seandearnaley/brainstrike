import { createLogger } from '@brainstrike/logging';
import { getErrorMessage } from '@brainstrike/utils/error-utils';
import { AlertTriangle, RotateCw } from 'lucide-react';
import * as React from 'react';
// Relative imports, never the `@brainstrike/ui` barrel: the barrel re-exports
// this module, so importing it here would close a source cycle (BST-890).
import { Button } from './button';
import { toast } from './use-toast';

const logger = createLogger('ThemeProvider');

export type Theme = 'dark' | 'light' | 'system';

export interface ThemeStorageAdapter {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
}

interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageAdapter: ThemeStorageAdapter;
  storageKey?: string;
}

interface ThemeProviderState {
  setTheme: (theme: Theme) => void;
  theme: Theme;
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
  defaultTheme = 'system',
  storageKey = 'ui-theme',
  storageAdapter,
  ...props
}: ThemeProviderProps) {
  const [theme, setTheme] = React.useState<Theme>(defaultTheme);
  const [load, setLoad] = React.useState<ThemeLoad>(LOADING);
  const [attempt, setAttempt] = React.useState(0);

  // Only access storage after component is mounted (client-side). A failed read
  // stops here with a visible failure (BST-1731): it never substitutes the
  // default theme on its own, and it never writes over the saved preference.
  React.useEffect(() => {
    let current = true;
    storageAdapter.getItem(storageKey).then(
      (savedTheme) => {
        if (!current) {
          return;
        }
        if (savedTheme) {
          setTheme(savedTheme as Theme);
        }
        setLoad(READY);
      },
      (error: unknown) => {
        if (!current) {
          return;
        }
        logger.error('Reading the saved theme preference failed', { attempt, error, storageKey });
        setLoad({ error, status: 'failed' });
      }
    );
    return () => {
      current = false;
    };
  }, [attempt, storageAdapter, storageKey]);

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
      storageAdapter.setItem(storageKey, newTheme).catch((error: unknown) => {
        logger.error('Saving the theme preference failed', {
          error,
          storageKey,
          theme: newTheme,
        });
        toast({
          description: 'The theme changed for this session, but it could not be saved.',
          title: 'Theme not saved',
          variant: 'destructive',
        });
      });
      setTheme(newTheme);
    },
    [storageAdapter, storageKey]
  );

  const value = React.useMemo(
    () => ({
      setTheme: setAndStoreTheme,
      theme,
    }),
    [theme, setAndStoreTheme]
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
        defaultTheme={defaultTheme}
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

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

/**
 * Shown in place of the app when the saved theme cannot be read. "Try again"
 * re-reads storage; "Continue" opens the app on the default theme for this
 * session only, leaving the saved preference untouched.
 */
function ThemeLoadFailure({
  defaultTheme,
  error,
  onContinue,
  onRetry,
}: {
  readonly defaultTheme: Theme;
  readonly error: unknown;
  readonly onContinue: () => void;
  readonly onRetry: () => void;
}): React.ReactElement {
  return (
    <div
      className="flex h-screen flex-col items-center justify-center gap-3 bg-background p-6 text-center text-foreground"
      data-slot="theme-load-failure"
      role="alert"
    >
      <AlertTriangle aria-hidden="true" className="size-6 text-destructive" />
      <h1 className="font-semibold text-lg">Your theme preference couldn't be read</h1>
      <p className="max-w-md text-muted-foreground text-sm">
        The app reads your saved theme before it opens, and reading it from storage failed. Your
        saved preference has not been changed.
      </p>
      <p className="max-w-md break-words font-mono text-muted-foreground text-xs">
        {getErrorMessage(error)}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button onClick={onRetry} size="sm" type="button">
          <RotateCw aria-hidden="true" />
          Try again
        </Button>
        <Button onClick={onContinue} size="sm" type="button" variant="outline">
          Continue with the {defaultTheme} theme
        </Button>
      </div>
      <p className="max-w-md text-muted-foreground text-xs">
        Continuing uses the {defaultTheme} theme for this session and keeps your saved preference.
      </p>
    </div>
  );
}

export const useTheme = () => {
  const context = React.useContext(ThemeProviderContext);

  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }

  return context;
};
