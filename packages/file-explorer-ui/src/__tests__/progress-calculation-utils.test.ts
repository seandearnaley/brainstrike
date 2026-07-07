import {
  calculateDynamicTotal,
  calculateProgressPercentage,
} from '@brainstrike/file-explorer-hooks';
import { describe, expect, it } from 'vitest';

describe('Progress Calculation Utilities', () => {
  describe('calculateDynamicTotal', () => {
    it('should return current total when loaded does not exceed it', () => {
      expect(calculateDynamicTotal(100, 50)).toBe(100);
      expect(calculateDynamicTotal(100, 100)).toBe(100);
      expect(calculateDynamicTotal(1000, 500)).toBe(1000);
    });

    it('should set total to loaded + buffer when exceeded', () => {
      expect(calculateDynamicTotal(100, 101)).toBe(601); // 101 + 500 (min buffer)
      expect(calculateDynamicTotal(100, 200)).toBe(700); // 200 + 500 (min buffer)
    });

    it('should use minimum buffer of 500', () => {
      expect(calculateDynamicTotal(50, 51)).toBe(551); // 51 + 500 (min buffer)
      expect(calculateDynamicTotal(10, 11)).toBe(511); // 11 + 500 (min buffer)
    });

    it('should use 25% buffer for large numbers', () => {
      expect(calculateDynamicTotal(1000, 2000)).toBe(2500); // 2000 + 500 (25% of 2000)
      expect(calculateDynamicTotal(1000, 4000)).toBe(5000); // 4000 + 1000 (25% of 4000)
    });

    it('should handle the problematic case correctly', () => {
      // The user's scenario: 3168 files with initial estimate of 100
      const result = calculateDynamicTotal(100, 3168);
      expect(result).toBe(3960); // 3168 + 792 (25% of 3168)

      // Percentage should now be reasonable
      const percentage = calculateProgressPercentage(3168, result);
      expect(percentage).toBe(80); // 3168/3960 = 80%
    });

    it('should always ensure total >= loaded', () => {
      const testCases = [101, 500, 1000, 3168, 10_000];
      for (const loaded of testCases) {
        const result = calculateDynamicTotal(100, loaded);
        expect(result).toBeGreaterThanOrEqual(loaded);
      }
    });
  });

  describe('calculateProgressPercentage', () => {
    it('should calculate correct percentages', () => {
      expect(calculateProgressPercentage(50, 100)).toBe(50);
      expect(calculateProgressPercentage(25, 100)).toBe(25);
      expect(calculateProgressPercentage(75, 100)).toBe(75);
      expect(calculateProgressPercentage(100, 100)).toBe(100);
    });

    it('should handle zero total gracefully', () => {
      expect(calculateProgressPercentage(50, 0)).toBe(0);
      expect(calculateProgressPercentage(0, 0)).toBe(0);
    });

    it('should round to nearest integer', () => {
      expect(calculateProgressPercentage(33, 100)).toBe(33);
      expect(calculateProgressPercentage(66, 100)).toBe(66);
      expect(calculateProgressPercentage(1, 3)).toBe(33); // 33.333... rounds to 33
      expect(calculateProgressPercentage(2, 3)).toBe(67); // 66.666... rounds to 67
    });

    it('should handle the problematic case from the bug report', () => {
      // This was the original issue: 3168 files with estimate of 100
      expect(calculateProgressPercentage(3168, 100)).toBe(3168); // This shows the problem

      // With proper dynamic adjustment, it should be reasonable
      const adjustedTotal = calculateDynamicTotal(100, 3168);
      expect(adjustedTotal).toBe(3960); // 3168 + 792 (25% buffer)
      expect(calculateProgressPercentage(3168, adjustedTotal)).toBe(80);
    });

    it('should handle very large numbers', () => {
      expect(calculateProgressPercentage(999_999, 1_000_000)).toBe(100);
      expect(calculateProgressPercentage(500_000, 1_000_000)).toBe(50);
    });

    it('should never exceed 100% when total is properly adjusted', () => {
      const testCases = [
        { expectedPercentage: 23, initialTotal: 100, loaded: 150 }, // 150/650 = 23%
        { expectedPercentage: 80, initialTotal: 100, loaded: 3168 }, // 3168/3960 = 80%
        { expectedPercentage: 50, initialTotal: 200, loaded: 500 }, // 500/1000 = 50%
      ];

      for (const { loaded, initialTotal, expectedPercentage } of testCases) {
        const adjustedTotal = calculateDynamicTotal(initialTotal, loaded);
        const percentage = calculateProgressPercentage(loaded, adjustedTotal);
        expect(percentage).toBe(expectedPercentage);
        expect(percentage).toBeLessThanOrEqual(100);
        expect(percentage).toBeGreaterThan(0);
      }
    });
  });

  describe('Integration tests', () => {
    it('should handle the exact scenario from the bug report', () => {
      let total = 100; // Initial estimate
      const finalLoaded = 3168;

      // Simulate the single large adjustment (what actually happens)
      total = calculateDynamicTotal(total, finalLoaded);
      const finalPercentage = calculateProgressPercentage(finalLoaded, total);
      expect(finalPercentage).toBe(80); // Should be exactly 80%
      expect(finalPercentage).toBeLessThanOrEqual(100);
      expect(finalPercentage).toBeGreaterThan(50);
    });

    it('should prevent the wild percentage calculations', () => {
      // Test the exact scenario: 3168 files with 100 estimate
      const problematicPercentage = calculateProgressPercentage(3168, 100);
      expect(problematicPercentage).toBe(3168); // This demonstrates the problem

      // With dynamic adjustment, it should be fixed
      const adjustedTotal = calculateDynamicTotal(100, 3168);
      const fixedPercentage = calculateProgressPercentage(3168, adjustedTotal);
      expect(fixedPercentage).toBe(80); // Should be exactly 80%
      expect(fixedPercentage).toBeLessThanOrEqual(100);
    });
  });
});
