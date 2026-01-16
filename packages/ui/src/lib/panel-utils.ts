import type { PanelPersistenceState } from '../types/panel';
import { DEFAULT_PANEL_SIZES, MIN_PANEL_SIZES } from './panel-constants';

/**
 * Validates and normalizes panel sizes.
 * - Ensures sizes are numbers within valid range (0-100)
 * - Enforces minimum sizes for visible panels (prevents unusably small panels)
 * - Normalizes total to not exceed 100%
 */
export const validateAndNormalizeSizes = (sizes: number[]): number[] => {
  if (!sizes || sizes.length === 0) {
    return [];
  }

  // First pass: ensure valid numbers within 0-100
  const validSizes = sizes.map((size, index) => {
    const num = typeof size === 'number' && !Number.isNaN(size) ? size : 0;
    const clamped = Math.max(0, Math.min(100, num));

    // If the panel has a non-zero size, enforce minimum
    // This prevents persisted tiny sizes from making panels unusable
    if (clamped > 0 && clamped < (MIN_PANEL_SIZES[index] ?? 10)) {
      return DEFAULT_PANEL_SIZES[index] ?? 20;
    }

    return clamped;
  });

  const total = validSizes.reduce((sum, size) => sum + size, 0);

  if (total === 0) {
    return validSizes.map(() => 100 / validSizes.length);
  }

  if (total > 100) {
    return validSizes.map((size) => (size / total) * 100);
  }

  return validSizes;
};

export const statesEqual = (a: PanelPersistenceState | null, b: PanelPersistenceState): boolean =>
  !!a &&
  a.sizes.length === b.sizes.length &&
  a.sizes.every((v, i) => v === b.sizes[i]) &&
  a.showConsole === b.showConsole &&
  a.showLeftPanel === b.showLeftPanel &&
  a.showRightPanel === b.showRightPanel;
