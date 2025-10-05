/**
 * Theme CSS Variables Consistency Tests
 *
 * These tests verify that the theme provider correctly applies CSS classes.
 * Actual CSS variable values are tested in E2E tests where stylesheets are loaded.
 *
 * For CSS variable consistency verification, see:
 * - apps/web/e2e/theme-css-consistency.test.ts
 */

import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ThemeProvider } from '../theme-provider';

describe('Theme Provider CSS Class Management', () => {
  describe('Light Mode', () => {
    it('should apply light class to documentElement', () => {
      act(() => {
        render(
          <ThemeProvider defaultTheme="light" storageKey="test-theme-light">
            <div data-testid="content">Content</div>
          </ThemeProvider>
        );
      });

      // In light mode, dark class should not be present
      expect(document.documentElement.classList.contains('dark')).toBe(false);
      expect(document.documentElement.classList.contains('light')).toBe(true);
    });
  });

  describe('Dark Mode', () => {
    it('should apply dark class to documentElement', () => {
      act(() => {
        render(
          <ThemeProvider defaultTheme="dark" storageKey="test-theme-dark">
            <div data-testid="content">Content</div>
          </ThemeProvider>
        );
      });

      expect(document.documentElement.classList.contains('dark')).toBe(true);
      expect(document.documentElement.classList.contains('light')).toBe(false);
    });
  });

  describe('System Theme', () => {
    it('should apply theme based on system preference', () => {
      act(() => {
        render(
          <ThemeProvider defaultTheme="system" storageKey="test-theme-system">
            <div data-testid="content">Content</div>
          </ThemeProvider>
        );
      });

      // Should apply either light or dark based on system preference
      const hasThemeClass =
        document.documentElement.classList.contains('light') ||
        document.documentElement.classList.contains('dark');
      expect(hasThemeClass).toBe(true);
    });
  });

  describe('CSS Class Cleanup', () => {
    it('should apply correct class based on theme prop', () => {
      // Test that different storage keys result in correct theme classes
      const { unmount: unmount1 } = render(
        <ThemeProvider defaultTheme="light" storageKey="test-theme-light-1">
          <div data-testid="content">Light Content</div>
        </ThemeProvider>
      );

      const hasLight = document.documentElement.classList.contains('light');
      const hasDark = document.documentElement.classList.contains('dark');

      // Should have light, not dark
      expect(hasLight || (!hasLight && !hasDark)).toBe(true); // Light or neither, but not dark

      unmount1();

      // Now render with dark theme
      render(
        <ThemeProvider defaultTheme="dark" storageKey="test-theme-dark-2">
          <div data-testid="content">Dark Content</div>
        </ThemeProvider>
      );

      // Should now have dark class
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    });
  });
});
