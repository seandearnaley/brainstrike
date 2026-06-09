/**
 * Tests for computeScanningStatusProps utility
 */

import { describe, expect, it, vi } from 'vitest';

import { computeScanningStatusProps } from '../scanning-status-props';

describe('computeScanningStatusProps', () => {
  const mockCancelExpandAll = vi.fn();
  const mockHandleCancelOperation = vi.fn();

  const defaultInput = {
    loadingProgress: null,
    isExpandingAll: false,
    expandAllProgress: null,
    cancellable: false,
    isCancelling: false,
    cancelExpandAll: mockCancelExpandAll,
    handleCancelOperation: mockHandleCancelOperation,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('when not scanning', () => {
    it('should return null when not loading and not expanding', () => {
      const result = computeScanningStatusProps(defaultInput);
      expect(result).toBeNull();
    });

    it('should return null when loadingProgress exists but isInitialLoading is false', () => {
      const result = computeScanningStatusProps({
        ...defaultInput,
        loadingProgress: { isInitialLoading: false },
      });
      expect(result).toBeNull();
    });
  });

  describe('when initial loading', () => {
    it('should return scanning props when isInitialLoading is true', () => {
      const result = computeScanningStatusProps({
        ...defaultInput,
        loadingProgress: { isInitialLoading: true },
      });

      expect(result).toEqual({
        isScanning: true,
        cancellable: false,
        isCancelling: false,
        onCancel: mockHandleCancelOperation,
      });
    });

    it('should use handleCancelOperation as onCancel when initial loading', () => {
      const result = computeScanningStatusProps({
        ...defaultInput,
        loadingProgress: { isInitialLoading: true },
        cancellable: true,
      });

      expect(result?.onCancel).toBe(mockHandleCancelOperation);
    });
  });

  describe('when expanding all', () => {
    it('should return scanning props with preparation message when no progress yet', () => {
      const result = computeScanningStatusProps({
        ...defaultInput,
        isExpandingAll: true,
      });

      expect(result).toEqual({
        isScanning: true,
        cancellable: true,
        isCancelling: false,
        onCancel: mockCancelExpandAll,
        currentPath: 'Preparing to expand directories...',
      });
    });

    it('should return scanning props with monotonic counts when expandAllProgress is provided', () => {
      const result = computeScanningStatusProps({
        ...defaultInput,
        isExpandingAll: true,
        expandAllProgress: { loaded: 5, total: 10 },
      });

      expect(result).toEqual({
        isScanning: true,
        cancellable: true,
        isCancelling: false,
        onCancel: mockCancelExpandAll,
        currentPath: 'Loading 5/10 directories',
        loadedCount: 5,
        totalCount: 10,
      });
    });

    it('should expose raw loaded/total counts (never a percentage)', () => {
      const result = computeScanningStatusProps({
        ...defaultInput,
        isExpandingAll: true,
        expandAllProgress: { loaded: 3, total: 4 },
      });

      expect(result?.loadedCount).toBe(3);
      expect(result?.totalCount).toBe(4);
      // The percentage was non-monotonic (total grows as lazy dirs are
      // discovered) and caused the flashing — it must be gone entirely.
      expect(result).not.toHaveProperty('percentage');
    });

    it('should use cancelExpandAll as onCancel when expanding all', () => {
      const result = computeScanningStatusProps({
        ...defaultInput,
        isExpandingAll: true,
      });

      expect(result?.onCancel).toBe(mockCancelExpandAll);
    });

    it('should set cancellable to true when expanding all regardless of input', () => {
      const result = computeScanningStatusProps({
        ...defaultInput,
        isExpandingAll: true,
        cancellable: false,
      });

      expect(result?.cancellable).toBe(true);
    });

    it('should not include counts when total is 0', () => {
      const result = computeScanningStatusProps({
        ...defaultInput,
        isExpandingAll: true,
        expandAllProgress: { loaded: 0, total: 0 },
      });

      expect(result).not.toHaveProperty('loadedCount');
      expect(result).not.toHaveProperty('totalCount');
      expect(result).not.toHaveProperty('percentage');
      expect(result?.currentPath).toBe('Preparing to expand directories...');
    });
  });

  describe('cancellation state', () => {
    it('should pass through isCancelling state', () => {
      const result = computeScanningStatusProps({
        ...defaultInput,
        loadingProgress: { isInitialLoading: true },
        isCancelling: true,
      });

      expect(result?.isCancelling).toBe(true);
    });
  });
});
