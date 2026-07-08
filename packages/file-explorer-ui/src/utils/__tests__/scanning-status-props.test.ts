/**
 * Tests for computeScanningStatusProps utility
 */

import { describe, expect, it, vi } from 'vitest';

import { computeScanningStatusProps } from '../scanning-status-props';

describe('computeScanningStatusProps', () => {
  const mockCancelExpandAll = vi.fn();
  const mockHandleCancelOperation = vi.fn();

  const defaultInput = {
    cancelExpandAll: mockCancelExpandAll,
    cancellable: false,
    expandAllProgress: null,
    handleCancelOperation: mockHandleCancelOperation,
    isCancelling: false,
    isExpandingAll: false,
    loadingProgress: null,
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
        cancellable: false,
        isCancelling: false,
        isScanning: true,
        onCancel: mockHandleCancelOperation,
      });
    });

    it('should use handleCancelOperation as onCancel when initial loading', () => {
      const result = computeScanningStatusProps({
        ...defaultInput,
        cancellable: true,
        loadingProgress: { isInitialLoading: true },
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
        cancellable: true,
        currentPath: 'Preparing to expand directories...',
        isCancelling: false,
        isScanning: true,
        onCancel: mockCancelExpandAll,
      });
    });

    it('should return scanning props with monotonic counts when expandAllProgress is provided', () => {
      const result = computeScanningStatusProps({
        ...defaultInput,
        expandAllProgress: { loaded: 5, total: 10 },
        isExpandingAll: true,
      });

      expect(result).toEqual({
        cancellable: true,
        currentPath: 'Loading 5/10 directories',
        isCancelling: false,
        isScanning: true,
        loadedCount: 5,
        onCancel: mockCancelExpandAll,
        totalCount: 10,
      });
    });

    it('should expose raw loaded/total counts (never a percentage)', () => {
      const result = computeScanningStatusProps({
        ...defaultInput,
        expandAllProgress: { loaded: 3, total: 4 },
        isExpandingAll: true,
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
        cancellable: false,
        isExpandingAll: true,
      });

      expect(result?.cancellable).toBe(true);
    });

    it('should not include counts when total is 0', () => {
      const result = computeScanningStatusProps({
        ...defaultInput,
        expandAllProgress: { loaded: 0, total: 0 },
        isExpandingAll: true,
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
        isCancelling: true,
        loadingProgress: { isInitialLoading: true },
      });

      expect(result?.isCancelling).toBe(true);
    });
  });
});
