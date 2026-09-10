import { useEffect, useState } from 'react';
import { useTheme } from '../theme-provider';

export type ResolvedTheme = 'light' | 'dark';

/**
 * Hook to resolve the current theme, handling 'system' by detecting
 * the user's preference via matchMedia.
 */
export function useResolvedTheme(): ResolvedTheme {
  const { mode: configuredMode } = useTheme();
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>('light');

  useEffect(() => {
    if (configuredMode === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      setResolvedTheme(mediaQuery.matches ? 'dark' : 'light');

      const handler = (e: MediaQueryListEvent) => {
        setResolvedTheme(e.matches ? 'dark' : 'light');
      };

      mediaQuery.addEventListener('change', handler);
      return () => mediaQuery.removeEventListener('change', handler);
    }

    setResolvedTheme(configuredMode);
    return () => {};
  }, [configuredMode]);

  return resolvedTheme;
}
