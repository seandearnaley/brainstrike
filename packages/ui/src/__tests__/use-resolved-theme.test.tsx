import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useResolvedTheme } from '../hooks/use-resolved-theme';

const useThemeMock = vi.fn();

vi.mock('../theme-provider', () => ({
  useTheme: () => useThemeMock(),
}));

function ThemeProbe() {
  return <div data-testid="resolved-theme">{useResolvedTheme()}</div>;
}

describe('useResolvedTheme', () => {
  it('returns the configured theme when not using system mode', () => {
    useThemeMock.mockReturnValue({ mode: 'dark' });

    render(<ThemeProbe />);

    expect(screen.getByTestId('resolved-theme')).toHaveTextContent('dark');
  });

  it('tracks system theme changes via matchMedia', async () => {
    let handler: ((event: MediaQueryListEvent) => void) | undefined;
    const addEventListener = vi.fn(
      (_type: string, nextHandler: (event: MediaQueryListEvent) => void) => {
        handler = nextHandler;
      }
    );
    const removeEventListener = vi.fn();

    useThemeMock.mockReturnValue({ mode: 'system' });
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        addEventListener,
        matches: true,
        media: '(prefers-color-scheme: dark)',
        onchange: null,
        removeEventListener,
      }))
    );

    const { unmount } = render(<ThemeProbe />);

    expect(screen.getByTestId('resolved-theme')).toHaveTextContent('dark');
    expect(addEventListener).toHaveBeenCalledWith('change', expect.any(Function));

    await act(async () => {
      handler?.({ matches: false } as MediaQueryListEvent);
    });
    expect(screen.getByTestId('resolved-theme')).toHaveTextContent('light');

    unmount();
    expect(removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });
});
