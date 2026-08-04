import { useEffect, useState } from 'react';
import { useTheme } from '../theme-provider';

export type ResolvedTheme = 'light' | 'dark';

/**
 * Hook to resolve the current theme, handling 'system' by detecting
 * the user's preference via matchMedia.
 */
export function useResolvedTheme(): ResolvedTheme {
  const { theme: configuredTheme } = useTheme();
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>('light');

  useEffect(() => {
    if (configuredTheme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      setResolvedTheme(mediaQuery.matches ? 'dark' : 'light');

      const handler = (e: MediaQueryListEvent) => {
        setResolvedTheme(e.matches ? 'dark' : 'light');
      };

      mediaQuery.addEventListener('change', handler);
      return () => mediaQuery.removeEventListener('change', handler);
    }

    setResolvedTheme(configuredTheme as ResolvedTheme);
    return () => {};
  }, [configuredTheme]);

  return resolvedTheme;
}
