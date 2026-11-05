/**
 * @vitest-environment happy-dom
 */

import { act } from '@brainstrike/test-utils/react-act';
import { type ThemeMode, ThemeProvider, useTheme } from '@brainstrike/ui';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APPEARANCE_STORAGE_KEY, chooseAppearance, useAppearanceStore } from '../appearance-store';

/** The provider wired to the store, as `AppLayout` mounts it. */
function AppTheme({ children, defaultMode }: { children: ReactNode; defaultMode?: ThemeMode }) {
  const appearance = useAppearanceStore();
  return (
    <ThemeProvider
      appearance={appearance}
      onAppearanceChange={chooseAppearance}
      {...(defaultMode ? { defaultMode } : {})}
    >
      {children}
    </ThemeProvider>
  );
}

/** Reads `localStorage` again into an empty store, as the app does when it reopens. */
async function openApp(defaultMode?: ThemeMode) {
  const saved = localStorage.getItem(APPEARANCE_STORAGE_KEY);
  // Emptying the store saves `{}`; put back what the last session saved.
  useAppearanceStore.setState({}, true);
  if (saved !== null) {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, saved);
  }
  await useAppearanceStore.persist.rehydrate();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AppTheme {...(defaultMode ? { defaultMode } : {})}>{children}</AppTheme>
  );
  return renderHook(() => useTheme(), { wrapper });
}

function seed(state: Record<string, unknown>): void {
  localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ state, version: 1 }));
}

describe('appearance store with ThemeProvider', () => {
  beforeEach(() => {
    useAppearanceStore.setState({}, true);
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
    root.removeAttribute('data-code-theme-light');
    root.removeAttribute('data-code-theme-dark');
    root.removeAttribute('data-motion');
    root.removeAttribute('data-transcript-size');
    root.removeAttribute('data-transcript-width');
    root.style.removeProperty('--code-font-size');
  });

  it('opens on the defaults and applies them to the document', async () => {
    const { result } = await openApp();

    expect(result.current).toMatchObject({
      codeFont: 'geist-mono',
      codeThemeDark: 'classic',
      codeThemeLight: 'classic',
      font: 'geist',
      mode: 'system',
      theme: 'brainstrike',
    });
    const root = document.documentElement;
    // System mode follows the OS, dark in this test.
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.dataset['theme']).toBe('brainstrike');
    expect(root.dataset['codeThemeLight']).toBe('classic');
    expect(root.dataset['codeThemeDark']).toBe('classic');
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
      first.result.current.setCodeThemeLight('one');
      first.result.current.setCodeThemeDark('catppuccin');
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    first.unmount();

    const { result } = await openApp('light');

    expect(result.current).toMatchObject({
      codeFont: 'jetbrains-mono',
      codeThemeDark: 'catppuccin',
      codeThemeLight: 'one',
      font: 'inter',
      mode: 'dark',
      theme: 'tide',
    });
    const root = document.documentElement;
    expect(root.dataset['theme']).toBe('tide');
    expect(root.dataset['codeThemeLight']).toBe('one');
    expect(root.dataset['codeThemeDark']).toBe('catppuccin');
    expect(root.style.getPropertyValue('--font-sans')).toContain('"Inter Variable"');
    expect(root.style.getPropertyValue('--font-mono')).toContain('"JetBrains Mono Variable"');
  });

  it('keeps the reading and code size choices across a reopen, and clearing one restores the default', async () => {
    const first = await openApp();
    act(() => {
      first.result.current.setTranscriptTextSize('large');
      first.result.current.setTranscriptWidth('narrow');
      first.result.current.setMotion('reduced');
      first.result.current.setCodeFontSize(15);
      first.result.current.setCustomCodeFont('Berkeley Mono');
    });
    first.unmount();

    const second = await openApp();
    expect(second.result.current).toMatchObject({
      codeFontSize: 15,
      customCodeFont: 'Berkeley Mono',
      motion: 'reduced',
      transcriptTextSize: 'large',
      transcriptWidth: 'narrow',
    });
    const root = document.documentElement;
    expect(root.dataset['transcriptSize']).toBe('large');
    expect(root.dataset['transcriptWidth']).toBe('narrow');
    expect(root.dataset['motion']).toBe('reduce');
    expect(root.style.getPropertyValue('--code-font-size')).toBe('15px');
    expect(root.style.getPropertyValue('--font-mono')).toMatch(
      /^"Berkeley Mono", "Geist Mono Variable"/u
    );

    act(() => {
      second.result.current.setMotion('system');
      second.result.current.setCodeFontSize(null);
      second.result.current.setCustomCodeFont('');
    });
    second.unmount();

    const { result } = await openApp();
    expect(result.current).toMatchObject({
      codeFontSize: null,
      customCodeFont: '',
      motion: 'system',
    });
    expect(root.dataset['motion']).toBeUndefined();
    expect(root.style.getPropertyValue('--code-font-size')).toBe('');
    expect(root.style.getPropertyValue('--font-mono')).toMatch(/^"Geist Mono Variable"/u);
  });

  it('uses a saved custom font only as a font name, and drops a size this build does not offer', async () => {
    seed({ codeFontSize: 99, customCodeFont: 'x"; } body { color: red' });

    const { result } = await openApp();

    expect(result.current.codeFontSize).toBeNull();
    expect(document.documentElement.style.getPropertyValue('--font-mono')).toMatch(
      /^"x {2}body {2}color: red", "Geist Mono Variable"/u
    );
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
});
