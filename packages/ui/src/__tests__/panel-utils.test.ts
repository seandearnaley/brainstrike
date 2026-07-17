import { describe, expect, it } from 'vitest';
import { statesEqual, validateAndNormalizeSizes } from '../lib/panel-utils';
import type { PanelPersistenceState } from '../types/panel';

describe('panel-utils', () => {
  describe('validateAndNormalizeSizes', () => {
    it('returns empty array for empty input', () => {
      expect(validateAndNormalizeSizes([])).toEqual([]);
    });

    it('returns empty array for undefined-like input', () => {
      expect(validateAndNormalizeSizes(undefined as unknown as number[])).toEqual([]);
    });

    it('normalizes sizes that sum to more than 100', () => {
      const result = validateAndNormalizeSizes([60, 60, 60]);
      const sum = result.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(100, 5);
    });

    it('distributes equally when all sizes are 0', () => {
      const result = validateAndNormalizeSizes([0, 0, 0]);
      expect(result).toEqual([100 / 3, 100 / 3, 100 / 3]);
    });

    it('clamps negative values to 0', () => {
      const result = validateAndNormalizeSizes([-10, 50, 50]);
      expect(result[0]).toBe(0);
    });

    it('clamps values over 100 to 100', () => {
      const result = validateAndNormalizeSizes([150]);
      expect(result[0]).toBeLessThanOrEqual(100);
    });

    it('handles NaN values', () => {
      const result = validateAndNormalizeSizes([Number.NaN, 50, 50]);
      expect(result[0]).toBe(0);
    });

    it('preserves valid sizes that sum to less than 100', () => {
      const result = validateAndNormalizeSizes([30, 40, 20]);
      expect(result).toEqual([30, 40, 20]);
    });
  });

  describe('statesEqual', () => {
    const baseState: PanelPersistenceState = {
      showConsole: true,
      showLeftPanel: true,
      showRightPanel: true,
      sizes: [25, 50, 25],
    };

    it('returns true for identical states', () => {
      const other: PanelPersistenceState = { ...baseState };
      expect(statesEqual(baseState, other)).toBe(true);
    });

    it('returns false when first state is null', () => {
      expect(statesEqual(null, baseState)).toBe(false);
    });

    it('returns false when sizes differ', () => {
      const other: PanelPersistenceState = { ...baseState, sizes: [30, 40, 30] };
      expect(statesEqual(baseState, other)).toBe(false);
    });

    it('returns false when sizes have different lengths', () => {
      const other: PanelPersistenceState = { ...baseState, sizes: [50, 50] };
      expect(statesEqual(baseState, other)).toBe(false);
    });

    it('returns false when showConsole differs', () => {
      const other: PanelPersistenceState = { ...baseState, showConsole: false };
      expect(statesEqual(baseState, other)).toBe(false);
    });

    it('returns false when showLeftPanel differs', () => {
      const other: PanelPersistenceState = { ...baseState, showLeftPanel: false };
      expect(statesEqual(baseState, other)).toBe(false);
    });

    it('returns false when showRightPanel differs', () => {
      const other: PanelPersistenceState = { ...baseState, showRightPanel: false };
      expect(statesEqual(baseState, other)).toBe(false);
    });
  });
});
