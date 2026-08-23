import type { DirectoryHandle, FileSystemAdapter, IFileNode } from '@brainstrike/types';
import { isAbortError } from '@brainstrike/utils/error-utils';
import { describe, expect, it, vi } from 'vitest';

import { querySelectableFiles } from '../recursive-selection-query';
import {
  createDirectoryNode,
  createFileNode,
  createMockAdapter,
} from './helpers/recursive-selection-test-kit';

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
 * 1. Raw directory listings are retained ONLY when the caller opts in via
 *    `collectDirectoryUpdates`, in BOTH scan modes. (RED-captured defect: the
 *    early-stop loop ignored the opt-in that throughput mode enforced.)
 * 2. Cancellation is a completion outcome, not a silent no-op: an adapter read
 *    that settles after abort rejects the query with its AbortError in BOTH
 *    scan modes. (RED-captured defect: throughput mode swallowed it and
 *    resolved a partial scan as success; early-stop mode rethrew.)
 * 3. A wedged adapter read that never settles keeps the query pending — the
 *    concurrency bound is not a liveness timeout, matching the content
 *    scheduler's documented ruling.
 */
describe('recursive-selection-query queue/frontier invariants (BST-478)', () => {
  describe('collectDirectoryUpdates opt-in (select-all memory guard)', () => {
    it('does not retain directory updates in early-stop mode unless collection is opted in', async () => {
      const adapter = createMockAdapter({
        '/root/sub': [createFileNode({ depth: 2, name: 'b.ts', path: '/root/sub/b.ts' })],
      });
      // A loaded root whose only child is one unloaded directory forces the
      // scan into early-stop mode with a small cap (<= LOW_LIMIT_SCAN_THRESHOLD).
      const root = createDirectoryNode({
        children: [
          createDirectoryNode({ depth: 1, loadState: 'unloaded', name: 'sub', path: '/root/sub' }),
        ],
        loadState: 'loaded',
        name: 'root',
        path: '/root',
      });

      const result = await querySelectableFiles({
        // Opt-in deliberately ABSENT: retention must be off by default in both
        // scan modes, matching the select-all memory guard documented on the option.
        excludeFilters: [],
        fileSystemAdapter: adapter,
        includeFilters: [],
        maxResults: 4,
        roots: [root],
        useRegex: false,
      });

      expect(result.filePaths).toEqual(['/root/sub/b.ts']);
      expect(adapter.readDirectory).toHaveBeenCalledTimes(1);
      expect(result.directoryUpdates).toEqual([]);
    });

    it('still retains directory updates in early-stop mode when collection IS opted in', async () => {
      const adapter = createMockAdapter({
        '/root/sub': [createFileNode({ depth: 2, name: 'b.ts', path: '/root/sub/b.ts' })],
      });
      const root = createDirectoryNode({
        children: [
          createDirectoryNode({ depth: 1, loadState: 'unloaded', name: 'sub', path: '/root/sub' }),
        ],
        loadState: 'loaded',
        name: 'root',
        path: '/root',
      });

      const result = await querySelectableFiles({
        // Complement of the default-off assertion above: the guard must FILTER,
        // not delete — folder-select callers opting in (via onDirectoriesLoaded)
        // keep hydration in small-subtree scans too.
        collectDirectoryUpdates: true,
        excludeFilters: [],
        fileSystemAdapter: adapter,
        includeFilters: [],
        maxResults: 4,
        roots: [root],
        useRegex: false,
      });

      expect(result.filePaths).toEqual(['/root/sub/b.ts']);
      expect(adapter.readDirectory).toHaveBeenCalledTimes(1);
      expect(result.directoryUpdates).toEqual([
        {
          children: [expect.objectContaining({ path: '/root/sub/b.ts' })],
          path: '/root/sub',
        },
      ]);
    });
  });

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
  });
});
