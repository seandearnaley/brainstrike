// @vitest-environment node
import type { DirectoryHandle, FileSystemAdapter, IFileNode } from '@brainstrike/types';
import { isAbortError } from '@brainstrike/utils/error-utils';
import { describe, expect, it, vi } from 'vitest';

// Future-regression simulation switch: when enabled, loadDirectoryChildren
// behaves like a loader variant WITHOUT the post-read AbortError recheck —
// reads settle successfully even after cancellation. Only the drain-timing
// independence test enables it; every other test gets the real loader.
const loaderSim = vi.hoisted(() => ({ bypassPostReadRecheck: false }));

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }),
  };
});

vi.mock('../lazy-tree-loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lazy-tree-loader')>();
  return {
    ...actual,
    loadDirectoryChildren: (
      adapter: FileSystemAdapter,
      node: IFileNode,
      options?: Parameters<typeof actual.loadDirectoryChildren>[2]
    ) => {
      if (loaderSim.bypassPostReadRecheck) {
        // Deliberately skips the loader's pre/post-read throwIfAborted
        // rechecks, simulating the reviewer's future-loader regression.
        return adapter.readDirectory({ path: node.path } as DirectoryHandle, {
          includeMetadata: false,
        });
      }
      return actual.loadDirectoryChildren(adapter, node, options);
    },
  };
});

import { querySelectableFiles } from '../recursive-selection-query';
import { createDirectoryNode, createFileNode } from './helpers/recursive-selection-test-kit';

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }),
  };
});

/**
 * BST-478 — recursive selection queue/frontier invariants.
 *
 * Pins the scan-completion contract that was previously implicit:
 *
 * 1. Cancellation is a completion outcome, not a silent no-op: an adapter
 *    read that settles after abort rejects the query with its AbortError in
 *    BOTH scan modes, even when the drain loop would otherwise exit silently.
 *    (RED-captured defects: throughput mode swallowed the AbortError; the
 *    drain could resolve a cancelled query when a late successful read
 *    discovered no further frontier work.)
 * 2. A wedged adapter read that never settles keeps the query pending — the
 *    concurrency bound is not a liveness timeout, matching the content
 *    scheduler's documented ruling.
 *
 * The `collectDirectoryUpdates` opt-in invariant lives parameterized over
 * both scan modes in `recursive-selection-query.test.ts` so it has exactly
 * one home and cannot drift.
 */
describe('recursive-selection-query queue/frontier invariants (BST-478)', () => {
  describe('cancellation completes the query with its AbortError in both scan modes', () => {
    function createControlledReadAdapter(
      controller: AbortController,
      lateReadMode: 'settle-after-abort' | 'hang-forever'
    ): { adapter: FileSystemAdapter; lateReadStarted: Promise<void> } {
      // Definite assignment: the Promise executor runs synchronously, so the
      // resolver exists before any adapter read can invoke it.
      let signalLateReadStart!: () => void;
      const lateReadStarted = new Promise<void>((resolve) => {
        signalLateReadStart = resolve;
      });
      const readDirectory = vi.fn(async (handle: DirectoryHandle) => {
        if (handle.path === '/root') {
          return [
            createDirectoryNode({ depth: 1, loadState: 'unloaded', name: 'a', path: '/root/a' }),
            createDirectoryNode({ depth: 1, loadState: 'unloaded', name: 'b', path: '/root/b' }),
          ];
        }
        if (handle.path === '/root/a') {
          return [createFileNode({ depth: 2, name: 'a.ts', path: '/root/a/a.ts' })];
        }
        if (handle.path === '/root/b') {
          // The interesting read: already IN FLIGHT when cancellation lands,
          // like a real native listing whose host ignores cooperative cancel.
          signalLateReadStart();
          if (lateReadMode === 'hang-forever') {
            await new Promise<IFileNode[]>(() => {});
          }
          await new Promise<void>((resolve) => {
            controller.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return [
            createDirectoryNode({ depth: 2, loadState: 'unloaded', name: 'c', path: '/root/b/c' }),
          ];
        }
        return [];
      });
      const adapter = {
        exists: vi.fn(),
        readDirectory,
        readFile: vi.fn(),
        requestDirectoryAccess: vi.fn(),
      } as unknown as FileSystemAdapter;
      return { adapter, lateReadStarted };
    }

    async function expectAbortError(query: Promise<unknown>): Promise<void> {
      const error = await query.then(
        () => undefined,
        (caught: unknown) => caught
      );
      // Production classifies cancellation through isAbortError
      // (handleSelectionError), so THAT predicate is the pinned contract —
      // not a specific message (native throwIfAborted and the module's
      // synthetic AbortError carry different texts).
      expect(isAbortError(error)).toBe(true);
    }

    it('rejects with an abort error when a late read settles during throughput mode (previously swallowed)', async () => {
      const controller = new AbortController();
      const { adapter, lateReadStarted } = createControlledReadAdapter(
        controller,
        'settle-after-abort'
      );

      const query = querySelectableFiles({
        abortSignal: controller.signal,
        excludeFilters: [],
        fileSystemAdapter: adapter,
        includeFilters: [],
        // Above LOW_LIMIT_SCAN_THRESHOLD forces throughput mode, where reads
        // run concurrently and settle independently of the consumer.
        maxResults: 300,
        roots: [createDirectoryNode({ loadState: 'unloaded', name: 'root', path: '/root' })],
        useRegex: false,
      });

      // Cancel only once the late-settling read is actually in flight.
      await lateReadStarted;
      controller.abort();

      await expectAbortError(query);
    });

    it('rejects with an abort error when a late read settles during early-stop mode', async () => {
      const controller = new AbortController();
      const { adapter, lateReadStarted } = createControlledReadAdapter(
        controller,
        'settle-after-abort'
      );

      const query = querySelectableFiles({
        abortSignal: controller.signal,
        excludeFilters: [],
        fileSystemAdapter: adapter,
        includeFilters: [],
        // At or below LOW_LIMIT_SCAN_THRESHOLD selects sequential early-stop.
        maxResults: 8,
        roots: [createDirectoryNode({ loadState: 'unloaded', name: 'root', path: '/root' })],
        useRegex: false,
      });

      await lateReadStarted;
      controller.abort();

      await expectAbortError(query);
    });

    it('stays pending when a cancelled in-flight read never settles (no invented liveness timeout)', async () => {
      const controller = new AbortController();
      const { adapter, lateReadStarted } = createControlledReadAdapter(controller, 'hang-forever');

      const query = querySelectableFiles({
        abortSignal: controller.signal,
        excludeFilters: [],
        fileSystemAdapter: adapter,
        includeFilters: [],
        maxResults: 300,
        roots: [createDirectoryNode({ loadState: 'unloaded', name: 'root', path: '/root' })],
        useRegex: false,
      });
      await lateReadStarted;
      controller.abort();

      // Mirrors the content-scheduler ruling: the concurrency bound is NOT a
      // liveness timeout. Cancellation stops SCHEDULING, but an in-flight
      // adapter read that neither resolves nor rejects leaves the scan queue
      // unclosed and the query pending. Bounding that requires an explicit
      // cancellation owner/trigger and adapter cancellation contract.
      const outcome = await Promise.race([
        query.then(
          () => 'settled' as const,
          () => 'settled' as const
        ),
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
      ]);
      expect(outcome).toBe('pending');
    });

    it('rejects on caller abort even when a late read settles SUCCESSFULLY past the drain (drain-timing independent)', async () => {
      // Simulates the reviewer's future-loader regression: an adapter read
      // that settles SUCCESSFULLY after cancellation, bypassing the loader's
      // post-read AbortError recheck, and whose listing contains ONLY files
      // — no new directory reaches the frontier, so the outer loop's
      // throwIfAborted never runs. Today the drain's only exit for this shape
      // is the silent scanAbortController.signal.aborted while-check, so the
      // cancelled query RESOLVES as success. The "cancellation is a
      // completion outcome" contract must not depend on the loader
      // rechecking after every read.
      const controller = new AbortController();
      let signalLateReadStart!: () => void;
      const lateReadStarted = new Promise<void>((resolve) => {
        signalLateReadStart = resolve;
      });
      const readDirectory = vi.fn(async (handle: DirectoryHandle) => {
        if (handle.path === '/root') {
          return [
            createDirectoryNode({ depth: 1, loadState: 'unloaded', name: 'a', path: '/root/a' }),
            createDirectoryNode({ depth: 1, loadState: 'unloaded', name: 'b', path: '/root/b' }),
          ];
        }
        if (handle.path === '/root/a') {
          return [createFileNode({ depth: 2, name: 'a.ts', path: '/root/a/a.ts' })];
        }
        if (handle.path === '/root/b') {
          signalLateReadStart();
          await new Promise<void>((resolve) => {
            controller.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          // Files only: consumes cleanly without extending the frontier.
          return [createFileNode({ depth: 2, name: 'late.ts', path: '/root/b/late.ts' })];
        }
        return [];
      });
      const adapter = {
        exists: vi.fn(),
        readDirectory,
        readFile: vi.fn(),
        requestDirectoryAccess: vi.fn(),
      } as unknown as FileSystemAdapter;

      const query = querySelectableFiles({
        abortSignal: controller.signal,
        excludeFilters: [],
        fileSystemAdapter: adapter,
        includeFilters: [],
        maxResults: 300,
        roots: [createDirectoryNode({ loadState: 'unloaded', name: 'root', path: '/root' })],
        useRegex: false,
      });
      // Active at CALL time: every read skips the loader's post-read
      // AbortError recheck, so b's listing arrives as a genuine SUCCESS
      // result after cancellation instead of being converted to AbortError.
      loaderSim.bypassPostReadRecheck = true;
      await lateReadStarted;
      controller.abort();

      try {
        await expectAbortError(query);
      } finally {
        loaderSim.bypassPostReadRecheck = false;
      }
    });
  });
});
