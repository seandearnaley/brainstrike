/**
 * Tests for useWorkerFlattenedTree hook
 *
 * Part of BST-148: Worker-backed tree flattening
 */

import type { FileTreeWorkerPort, FlattenedNode } from '@brainstrike/file-tree-worker';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import * as fileTreeTelemetry from '../../utils/file-tree-telemetry';
import { shouldUseWorkerFlattening, useWorkerFlattenedTree } from '../use-worker-flattened-tree';

describe('useWorkerFlattenedTree', () => {
  // Mock worker port
  let mockPort: {
    onFlattenedRows: Mock;
    flattenTree: Mock;
  };
  let mockCleanup: Mock;
  let capturedHandler: ((nodes: FlattenedNode[], count: number, durationMs: number) => void) | null;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandler = null;
    mockCleanup = vi.fn();

    mockPort = {
      flattenTree: vi.fn(),
      onFlattenedRows: vi.fn((handler) => {
        capturedHandler = handler;
        return mockCleanup;
      }),
    };
  });

  describe('threshold-based enabling', () => {
    it('disables worker flattening for small trees (below threshold)', () => {
      const portRef = { current: mockPort as unknown as FileTreeWorkerPort };
      const expandedPaths = new Set<string>();

      const { result } = renderHook(() =>
        useWorkerFlattenedTree({
          approximateNodeCount: 5000, // Below 10,000 threshold
          expandedPaths,
          portRef,
        })
      );

      expect(result.current.isWorkerEnabled).toBe(false);
      expect(result.current.flattenedNodes).toBeNull();
      expect(mockPort.onFlattenedRows).not.toHaveBeenCalled();
    });

    it('enables worker flattening for large trees (above threshold)', () => {
      const portRef = { current: mockPort as unknown as FileTreeWorkerPort };
      const expandedPaths = new Set<string>();

      const { result } = renderHook(() =>
        useWorkerFlattenedTree({
          approximateNodeCount: 15_000, // Above 10,000 threshold
          expandedPaths,
          portRef,
        })
      );

      expect(result.current.isWorkerEnabled).toBe(true);
      expect(mockPort.onFlattenedRows).toHaveBeenCalledOnce();
    });

    it('stays disabled when enabled is false, even above threshold or forced', () => {
      // The consumer disables the worker whenever the normalized-tree render
      // path is active — the worker's flattened output would be discarded, and
      // its late arrival triggers a spurious row rebuild.
      const portRef = { current: mockPort as unknown as FileTreeWorkerPort };
      const expandedPaths = new Set<string>();

      const { result } = renderHook(() =>
        useWorkerFlattenedTree({
          approximateNodeCount: 15_000,
          enabled: false,
          expandedPaths,
          forceWorker: true,
          portRef,
        })
      );

      expect(result.current.isWorkerEnabled).toBe(false);
      expect(mockPort.onFlattenedRows).not.toHaveBeenCalled();
      expect(mockPort.flattenTree).not.toHaveBeenCalled();
    });

    it('enables worker flattening when forceWorker is true', () => {
      const portRef = { current: mockPort as unknown as FileTreeWorkerPort };
      const expandedPaths = new Set<string>();

      const { result } = renderHook(() =>
        useWorkerFlattenedTree({
          approximateNodeCount: 100, // Well below threshold
          expandedPaths,
          forceWorker: true,
          portRef,
        })
      );

      expect(result.current.isWorkerEnabled).toBe(true);
      expect(mockPort.onFlattenedRows).toHaveBeenCalledOnce();
    });
  });

  describe('handler registration', () => {
    it('registers onFlattenedRows handler when enabled', () => {
      const portRef = { current: mockPort as unknown as FileTreeWorkerPort };
      const expandedPaths = new Set<string>();

      renderHook(() =>
        useWorkerFlattenedTree({
          approximateNodeCount: 15_000,
          expandedPaths,
          portRef,
        })
      );

      expect(mockPort.onFlattenedRows).toHaveBeenCalledWith(expect.any(Function));
    });

    it('cleans up handler on unmount', () => {
      const portRef = { current: mockPort as unknown as FileTreeWorkerPort };
      const expandedPaths = new Set<string>();

      const { unmount } = renderHook(() =>
        useWorkerFlattenedTree({
          approximateNodeCount: 15_000,
          expandedPaths,
          portRef,
        })
      );

      expect(mockCleanup).not.toHaveBeenCalled();

      unmount();

      expect(mockCleanup).toHaveBeenCalledOnce();
    });

    it('does not register handler when port is null', () => {
      const portRef = { current: null };
      const expandedPaths = new Set<string>();

      renderHook(() =>
        useWorkerFlattenedTree({
          approximateNodeCount: 15_000,
          expandedPaths,
          portRef,
        })
      );

      expect(mockPort.onFlattenedRows).not.toHaveBeenCalled();
    });
  });

  describe('flatten requests', () => {
    it('auto-requests flatten when enabled', () => {
      const portRef = { current: mockPort as unknown as FileTreeWorkerPort };
      const expandedPaths = new Set(['/root', '/root/src']);

      renderHook(() =>
        useWorkerFlattenedTree({
          approximateNodeCount: 15_000,
          expandedPaths,
          portRef,
        })
      );

      expect(mockPort.flattenTree).toHaveBeenCalledWith(['/root', '/root/src']);
    });

    it('does not request flatten when disabled', () => {
      const portRef = { current: mockPort as unknown as FileTreeWorkerPort };
      const expandedPaths = new Set(['/root']);

      renderHook(() =>
        useWorkerFlattenedTree({
          approximateNodeCount: 5000, // Below threshold
          expandedPaths,
          portRef,
        })
      );

      expect(mockPort.flattenTree).not.toHaveBeenCalled();
    });

    it('re-requests flatten when expandedPaths change', () => {
      const portRef = { current: mockPort as unknown as FileTreeWorkerPort };
      let expandedPaths = new Set(['/root']);

      const { rerender } = renderHook(
        ({ paths }) =>
          useWorkerFlattenedTree({
            approximateNodeCount: 15_000,
            expandedPaths: paths,
            portRef,
          }),
        { initialProps: { paths: expandedPaths } }
      );

      expect(mockPort.flattenTree).toHaveBeenCalledTimes(1);

      // Update expanded paths
      expandedPaths = new Set(['/root', '/root/src', '/root/tests']);
      rerender({ paths: expandedPaths });

      expect(mockPort.flattenTree).toHaveBeenCalledTimes(2);
      expect(mockPort.flattenTree).toHaveBeenLastCalledWith(['/root', '/root/src', '/root/tests']);
    });

    it('re-requests flatten when tree content changes without expansion changes', () => {
      const portRef = { current: mockPort as unknown as FileTreeWorkerPort };
      const expandedPaths = new Set(['/root']);

      const { rerender } = renderHook(
        ({ revision }) =>
          useWorkerFlattenedTree({
            approximateNodeCount: 15_000,
            expandedPaths,
            portRef,
            treeRevision: revision,
          }),
        { initialProps: { revision: 1 } }
      );

      expect(mockPort.flattenTree).toHaveBeenCalledTimes(1);

      rerender({ revision: 2 });

      expect(mockPort.flattenTree).toHaveBeenCalledTimes(2);
      expect(mockPort.flattenTree).toHaveBeenLastCalledWith(['/root']);
    });

    it('requestFlatten can be called manually', () => {
      const portRef = { current: mockPort as unknown as FileTreeWorkerPort };
      const expandedPaths = new Set(['/root']);

      const { result } = renderHook(() =>
        useWorkerFlattenedTree({
          approximateNodeCount: 15_000,
          expandedPaths,
          portRef,
        })
      );

      // Auto-request happens on mount
      expect(mockPort.flattenTree).toHaveBeenCalledTimes(1);

      // Manual request
      act(() => {
        result.current.requestFlatten();
      });

      expect(mockPort.flattenTree).toHaveBeenCalledTimes(2);
    });
  });

  describe('result handling', () => {
    it('updates state when flattened result is received', async () => {
      const recordTelemetrySpy = vi.spyOn(fileTreeTelemetry, 'recordFileTreeTelemetry');
      const portRef = { current: mockPort as unknown as FileTreeWorkerPort };
      const expandedPaths = new Set<string>();

      const { result } = renderHook(() =>
        useWorkerFlattenedTree({
          approximateNodeCount: 15_000,
          expandedPaths,
          portRef,
        })
      );

      expect(result.current.flattenedNodes).toBeNull();
      expect(result.current.lastDurationMs).toBeNull();

      // Simulate worker response
      const mockNodes: FlattenedNode[] = [
        {
          depth: 0,
          node: {
            children: [],
            depth: 0,
            loadState: 'loaded',
            name: 'root',
            path: '/root',
            rootFolderId: 'root',
            type: 'directory',
          },
        },
        {
          depth: 1,
          node: {
            depth: 1,
            name: 'file.ts',
            path: '/root/file.ts',
            rootFolderId: 'root',
            type: 'file',
          },
        },
      ];

      act(() => {
        capturedHandler?.(mockNodes, 2, 5.5);
      });

      expect(result.current.flattenedNodes).toEqual(mockNodes);
      expect(result.current.lastDurationMs).toBe(5.5);
      expect(recordTelemetrySpy).toHaveBeenCalledWith({
        durationMs: 5.5,
        event: 'file-tree.flatten',
        nodeCount: 2,
        rowCount: 2,
        source: 'worker',
      });
    });

    it('returns null flattenedNodes when disabled', () => {
      const portRef = { current: mockPort as unknown as FileTreeWorkerPort };
      const expandedPaths = new Set<string>();

      const { result } = renderHook(() =>
        useWorkerFlattenedTree({
          approximateNodeCount: 5000, // Below threshold
          expandedPaths,
          portRef,
        })
      );

      expect(result.current.flattenedNodes).toBeNull();
      expect(result.current.lastDurationMs).toBeNull();
    });
  });
});

describe('shouldUseWorkerFlattening', () => {
  it('returns false for node counts below threshold', () => {
    expect(shouldUseWorkerFlattening(0)).toBe(false);
    expect(shouldUseWorkerFlattening(1000)).toBe(false);
    expect(shouldUseWorkerFlattening(9999)).toBe(false);
    expect(shouldUseWorkerFlattening(10_000)).toBe(false);
  });

  it('returns true for node counts above threshold', () => {
    expect(shouldUseWorkerFlattening(10_001)).toBe(true);
    expect(shouldUseWorkerFlattening(50_000)).toBe(true);
    expect(shouldUseWorkerFlattening(100_000)).toBe(true);
  });
});
