/**
 * Theme CSS Variables Consistency Tests
 *
 * These tests verify that the theme provider correctly applies CSS classes.
 * Actual CSS variable values are tested in E2E tests where stylesheets are loaded.
 *
 * For CSS variable consistency verification, see:
 * - apps/web/e2e/theme-css-consistency.test.ts
 */

import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ThemeProvider, type ThemeStorageAdapter } from '../theme-provider';

const themeStorageAdapter: ThemeStorageAdapter = {
  getItem: async () => null,
  setItem: async () => {},
};

describe('Theme Provider CSS Class Management', () => {
  describe('Light Mode', () => {
    it('should apply light class to documentElement', async () => {
      await act(async () => {
        render(
          <ThemeProvider
            defaultMode="light"
            storageAdapter={themeStorageAdapter}
            storageKey="test-theme-light"
          >
            <div data-testid="content">Content</div>
          </ThemeProvider>
        );
      });

      // Wait for theme effects to complete
      await waitFor(() => {
        // In light mode, dark class should not be present
        expect(document.documentElement.classList.contains('dark')).toBe(false);
        expect(document.documentElement.classList.contains('light')).toBe(true);
      });
      expect(document.documentElement.dataset['theme']).toBe('brainstrike');
    });
  });

  describe('Dark Mode', () => {
    it('should apply dark class to documentElement', async () => {
      await act(async () => {
        render(
          <ThemeProvider
            defaultMode="dark"
            storageAdapter={themeStorageAdapter}
            storageKey="test-theme-dark"
          >
            <div data-testid="content">Content</div>
          </ThemeProvider>
        );
      });

      await waitFor(() => {
        expect(document.documentElement.classList.contains('dark')).toBe(true);
        expect(document.documentElement.classList.contains('light')).toBe(false);
      });
    });
  });

  describe('System Theme', () => {
    it('should apply theme based on system preference', async () => {
      await act(async () => {
        render(
          <ThemeProvider
            defaultMode="system"
            storageAdapter={themeStorageAdapter}
            storageKey="test-theme-system"
          >
            <div data-testid="content">Content</div>
          </ThemeProvider>
        );
      });

      // Wait for theme effects to complete
      await waitFor(() => {
        // Should apply either light or dark based on system preference
        const hasThemeClass =
          document.documentElement.classList.contains('light') ||
          document.documentElement.classList.contains('dark');
        expect(hasThemeClass).toBe(true);
      });
    });
  });

  describe('CSS Class Cleanup', () => {
    it('should apply correct class based on theme prop', async () => {
      // Test that different storage keys result in correct theme classes
      let unmount1: () => void;
      await act(async () => {
        const result = render(
          <ThemeProvider
            defaultMode="light"
            storageAdapter={themeStorageAdapter}
            storageKey="test-theme-light-1"
          >
            <div data-testid="content">Light Content</div>
          </ThemeProvider>
        );
        unmount1 = result.unmount;
      });

      await waitFor(() => {
        const hasLight = document.documentElement.classList.contains('light');
        const hasDark = document.documentElement.classList.contains('dark');

        // Should have light, not dark
        expect(hasLight || !(hasLight || hasDark)).toBe(true); // Light or neither, but not dark
      });

      act(() => {
        unmount1();
      });

      // Now render with dark theme
      await act(async () => {
        render(
          <ThemeProvider
            defaultMode="dark"
            storageAdapter={themeStorageAdapter}
            storageKey="test-theme-dark-2"
          >
            <div data-testid="content">Dark Content</div>
          </ThemeProvider>
        );
      });

      await waitFor(() => {
        // Should now have dark class
        expect(document.documentElement.classList.contains('dark')).toBe(true);
      });
    });
  });
});
