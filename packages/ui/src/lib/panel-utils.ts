import type { PanelPersistenceState } from '../types/panel';

export const validateAndNormalizeSizes = (sizes: number[]): number[] => {
  if (!sizes || sizes.length === 0) {
    return [];
  }

  const validSizes = sizes.map((size) => {
    const num = typeof size === 'number' && !Number.isNaN(size) ? size : 0;
    return Math.max(0, Math.min(100, num));
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
