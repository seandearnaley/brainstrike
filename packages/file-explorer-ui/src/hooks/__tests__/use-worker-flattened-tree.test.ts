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
    onFlattenedResult: Mock;
    flattenTree: Mock;
  };
  let mockCleanup: Mock;
  let capturedHandler: ((nodes: FlattenedNode[], count: number, durationMs: number) => void) | null;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandler = null;
    mockCleanup = vi.fn();

    mockPort = {
      onFlattenedResult: vi.fn((handler) => {
        capturedHandler = handler;
        return mockCleanup;
      }),
      flattenTree: vi.fn(),
    };
  });

  describe('threshold-based enabling', () => {
    it('disables worker flattening for small trees (below threshold)', () => {
      const portRef = { current: mockPort as unknown as FileTreeWorkerPort };
      const expandedPaths = new Set<string>();

      const { result } = renderHook(() =>
        useWorkerFlattenedTree({
          portRef,
          expandedPaths,
          approximateNodeCount: 5000, // Below 10,000 threshold
        })
      );

      expect(result.current.isWorkerEnabled).toBe(false);
      expect(result.current.flattenedNodes).toBeNull();
      expect(mockPort.onFlattenedResult).not.toHaveBeenCalled();
    });

    it('enables worker flattening for large trees (above threshold)', () => {
      const portRef = { current: mockPort as unknown as FileTreeWorkerPort };
      const expandedPaths = new Set<string>();

      const { result } = renderHook(() =>
        useWorkerFlattenedTree({
          portRef,
          expandedPaths,
          approximateNodeCount: 15_000, // Above 10,000 threshold
        })
      );

      expect(result.current.isWorkerEnabled).toBe(true);
      expect(mockPort.onFlattenedResult).toHaveBeenCalledOnce();
    });

    it('enables worker flattening when forceWorker is true', () => {
      const portRef = { current: mockPort as unknown as FileTreeWorkerPort };
      const expandedPaths = new Set<string>();

      const { result } = renderHook(() =>
        useWorkerFlattenedTree({
          portRef,
          expandedPaths,
          approximateNodeCount: 100, // Well below threshold
          forceWorker: true,
        })
      );

      expect(result.current.isWorkerEnabled).toBe(true);
      expect(mockPort.onFlattenedResult).toHaveBeenCalledOnce();
    });
  });

  describe('handler registration', () => {
    it('registers onFlattenedResult handler when enabled', () => {
      const portRef = { current: mockPort as unknown as FileTreeWorkerPort };
      const expandedPaths = new Set<string>();

      renderHook(() =>
        useWorkerFlattenedTree({
          portRef,
          expandedPaths,
          approximateNodeCount: 15_000,
        })
      );

      expect(mockPort.onFlattenedResult).toHaveBeenCalledWith(expect.any(Function));
    });

    it('cleans up handler on unmount', () => {
      const portRef = { current: mockPort as unknown as FileTreeWorkerPort };
      const expandedPaths = new Set<string>();

      const { unmount } = renderHook(() =>
        useWorkerFlattenedTree({
          portRef,
          expandedPaths,
          approximateNodeCount: 15_000,
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
          portRef,
          expandedPaths,
          approximateNodeCount: 15_000,
        })
      );

      expect(mockPort.onFlattenedResult).not.toHaveBeenCalled();
    });
  });

  describe('flatten requests', () => {
    it('auto-requests flatten when enabled', () => {
      const portRef = { current: mockPort as unknown as FileTreeWorkerPort };
      const expandedPaths = new Set(['/root', '/root/src']);

      renderHook(() =>
        useWorkerFlattenedTree({
          portRef,
          expandedPaths,
          approximateNodeCount: 15_000,
        })
      );

      expect(mockPort.flattenTree).toHaveBeenCalledWith(['/root', '/root/src']);
    });

    it('does not request flatten when disabled', () => {
      const portRef = { current: mockPort as unknown as FileTreeWorkerPort };
      const expandedPaths = new Set(['/root']);

      renderHook(() =>
        useWorkerFlattenedTree({
          portRef,
          expandedPaths,
          approximateNodeCount: 5000, // Below threshold
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
            portRef,
            expandedPaths: paths,
            approximateNodeCount: 15_000,
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
            portRef,
            expandedPaths,
            approximateNodeCount: 15_000,
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
          portRef,
          expandedPaths,
          approximateNodeCount: 15_000,
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
          portRef,
          expandedPaths,
          approximateNodeCount: 15_000,
        })
      );

      expect(result.current.flattenedNodes).toBeNull();
      expect(result.current.lastDurationMs).toBeNull();

      // Simulate worker response
      const mockNodes: FlattenedNode[] = [
        {
          node: {
            path: '/root',
            name: 'root',
            type: 'directory',
            loadState: 'loaded',
            children: [],
            depth: 0,
            rootFolderId: 'root',
          },
          depth: 0,
        },
        {
          node: {
            path: '/root/file.ts',
            name: 'file.ts',
            type: 'file',
            depth: 1,
            rootFolderId: 'root',
          },
          depth: 1,
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
          portRef,
          expandedPaths,
          approximateNodeCount: 5000, // Below threshold
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
