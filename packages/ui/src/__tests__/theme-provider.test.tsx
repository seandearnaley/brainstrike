/**
 * @vitest-environment happy-dom
 */

import { act } from '@brainstrike/test-utils/react-act';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const APPEARANCE_KEY = 'ui-appearance';

/** A fresh module graph reads `localStorage` again, as the app does when it reopens. */
async function openApp(defaultMode?: 'dark' | 'light' | 'system') {
  vi.resetModules();
  const { ThemeProvider, useTheme } = await import('../theme-provider');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ThemeProvider {...(defaultMode ? { defaultMode } : {})}>{children}</ThemeProvider>
  );
  return renderHook(() => useTheme(), { wrapper });
}

function seed(state: Record<string, unknown>): void {
  localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ state, version: 1 }));
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      addEventListener: vi.fn(),
      matches: query === '(prefers-color-scheme: dark)',
      media: query,
      removeEventListener: vi.fn(),
    }));
  });

  afterEach(() => {
    localStorage.clear();
    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    root.removeAttribute('data-theme');
    root.removeAttribute('data-code-theme');
  });

  it('opens on the defaults and applies them to the document', async () => {
    const { result } = await openApp();

    expect(result.current).toMatchObject({
      codeFont: 'geist-mono',
      codeTheme: 'classic',
      font: 'geist',
      mode: 'system',
      theme: 'brainstrike',
    });
    const root = document.documentElement;
    // System mode follows the OS, dark in this test.
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.dataset['theme']).toBe('brainstrike');
    expect(root.dataset['codeTheme']).toBe('classic');
  });

  it('uses the default mode the app passes until the user picks one', async () => {
    const { result } = await openApp('light');

    expect(result.current.mode).toBe('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });

  it('keeps every appearance choice across a reopen', async () => {
    const first = await openApp('light');
    act(() => {
      first.result.current.setMode('dark');
      first.result.current.setTheme('tide');
      first.result.current.setFont('inter');
      first.result.current.setCodeFont('jetbrains-mono');
      first.result.current.setCodeTheme('one');
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    first.unmount();

    const { result } = await openApp('light');

    expect(result.current).toMatchObject({
      codeFont: 'jetbrains-mono',
      codeTheme: 'one',
      font: 'inter',
      mode: 'dark',
      theme: 'tide',
    });
    const root = document.documentElement;
    expect(root.dataset['theme']).toBe('tide');
    expect(root.dataset['codeTheme']).toBe('one');
    expect(root.style.getPropertyValue('--font-sans')).toContain('"Inter Variable"');
    expect(root.style.getPropertyValue('--font-mono')).toContain('"JetBrains Mono Variable"');
  });

  it('keeps the default for a saved value this build does not know', async () => {
    seed({ font: 'inter', mode: 'sepia', theme: 'retired' });

    const { result } = await openApp('light');

    expect(result.current.mode).toBe('light');
    expect(result.current.theme).toBe('brainstrike');
    expect(result.current.font).toBe('inter');
  });

  it('changes the palette without touching the mode', async () => {
    const { result } = await openApp('dark');

    act(() => {
      result.current.setTheme('orchid');
    });

    expect(result.current.mode).toBe('dark');
    expect(document.documentElement.dataset['theme']).toBe('orchid');
  });

  it('throws when useTheme is used outside the provider', async () => {
    const { useTheme } = await import('../theme-provider');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => renderHook(() => useTheme())).toThrow(
      'useTheme must be used within a ThemeProvider'
    );

    consoleSpy.mockRestore();
  });
});
