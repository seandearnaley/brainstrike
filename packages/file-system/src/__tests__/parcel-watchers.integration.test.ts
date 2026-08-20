// BST-568 slice 2: startParcelWatch against the REAL native binding.
// Env-sensitive (native module + wall-clock event delivery) — integration lane.
//
// BST-1328: these tests assert OUR normalization and ignore rules, layered on
// top of the OS watcher. When the host's watcher layer is not delivering they
// cannot say anything about that logic, so each one attributes its own failure
// — probing the platform at the moment the expected event failed to arrive —
// and steps aside only when that probe PROVES the layer beneath it was silent
// while libuv was still delivering. On a healthy host the probe never runs; a
// host where nothing at all delivers is NOT skipped, because that is a broken
// harness rather than the known platform fault.
//
// Internal `vi.waitFor` deadlines are strictly below the test timeout so an
// assertion failure ("expected [] to contain …", i.e. events were LOST) always
// beats the ambiguous "Test timed out" message.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAdjustedTimeout } from '@brainstrike/test-utils';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startParcelWatch } from '../adapters/parcel-watchers.js';
import { assertNoPlatformSkips, attributeWatcherFailure } from '../testing/watcher-liveness.js';
import type { DirectoryHandle, FileSystemChange, FileSystemWatchBatchMetadata } from '../types.js';

// Must exceed the inner deadline PLUS the attribution probe (~2s native + ~2s
// control) so the DIAGNOSTIC wins the race, never the bare "Test timed out":
// measured at exactly 15021ms against a 15s bound while building this. It
// bounds hangs only — every wait below is bounded by its own deadline.
vi.setConfig({ testTimeout: getAdjustedTimeout('heavy') });

const EVENT_DEADLINE_MS = 5000;

function makeHandle(path: string): DirectoryHandle {
  return { kind: 'directory', name: 'root', path } as DirectoryHandle;
}

describe('startParcelWatch (real binding)', () => {
  let root = '';
  let batches: FileSystemChange[][] = [];
  let stop: (() => void) | null = null;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bst568-real-'));
    batches = [];
  });

  afterEach(async () => {
    stop?.();
    stop = null;
    await rm(root, { force: true, recursive: true });
  });

  it('delivers normalized add/modify/remove batches for files and directories', async (ctx) => {
    stop = await startParcelWatch(makeHandle(root), (changes) => {
      batches.push(changes);
    });

    const filePath = join(root, 'note.md');
    const dirPath = join(root, 'folder');

    try {
      await writeFile(filePath, 'v1');
      await mkdir(dirPath);
      await vi.waitFor(
        () => {
          const flat = batches.flat();
          expect(flat).toContainEqual({ kind: 'file', path: filePath, type: 'added' });
          expect(flat).toContainEqual({ kind: 'directory', path: dirPath, type: 'added' });
        },
        { interval: 50, timeout: EVENT_DEADLINE_MS }
      );

      await writeFile(filePath, 'v2');
      await vi.waitFor(
        () => {
          expect(batches.flat()).toContainEqual({
            kind: 'file',
            path: filePath,
            type: 'modified',
          });
        },
        { interval: 50, timeout: EVENT_DEADLINE_MS }
      );

      await rm(filePath);
      await vi.waitFor(
        () => {
          expect(batches.flat()).toContainEqual({
            kind: 'directory',
            path: filePath,
            type: 'removed',
          });
        },
        { interval: 50, timeout: EVENT_DEADLINE_MS }
      );
    } catch (error) {
      await attributeWatcherFailure(ctx, error);
    }
  });

  it('stops delivering events after dispose', async (ctx) => {
    stop = await startParcelWatch(makeHandle(root), (changes) => {
      batches.push(changes);
    });

    try {
      // PROVE THE WATCH IS LIVE FIRST. Asserting only "nothing arrived after
      // dispose" passes vacuously on any host that delivers nothing at all —
      // it cannot tell a working disposer from a dead watcher, and did exactly
      // that on the BST-1328 host: this test was the ONE "passing" case in a
      // file whose every other test was timing out, a green result for a
      // subscription that had never delivered anything.
      await vi.waitFor(
        async () => {
          await writeFile(join(root, 'before-stop.txt'), 'x');
          expect(batches.flat().length).toBeGreaterThan(0);
        },
        { interval: 50, timeout: EVENT_DEADLINE_MS }
      );
    } catch (error) {
      await attributeWatcherFailure(ctx, error);
    }

    stop();
    stop = null;
    const deliveredBeforeStop = batches.flat().length;

    await writeFile(join(root, 'after-stop.txt'), 'x');
    await new Promise((resolve) => setTimeout(resolve, 600));
    // No attribution here: this assertion cannot fail BECAUSE of a dead
    // platform — silence is what it expects. A failure means the disposer
    // genuinely leaked, which is ours.
    expect(batches.flat().length).toBe(deliveredBeforeStop);
  });

  it('summarizes dist activity without exposing its detailed path', async (ctx) => {
    const metadataBatches: Array<FileSystemWatchBatchMetadata | undefined> = [];
    stop = await startParcelWatch(
      makeHandle(root),
      (changes, metadata) => {
        batches.push(changes);
        metadataBatches.push(metadata);
      },
      { reportDefaultFilteredChanges: true }
    );

    const keptPath = join(root, 'kept.txt');

    try {
      await mkdir(join(root, 'dist'));
      await writeFile(join(root, 'dist', 'generated.js'), 'x');
      await writeFile(keptPath, 'x');

      await vi.waitFor(
        () => {
          expect(batches.flat()).toContainEqual({
            kind: 'file',
            path: keptPath,
            type: 'added',
          });
        },
        { interval: 50, timeout: EVENT_DEADLINE_MS }
      );
    } catch (error) {
      await attributeWatcherFailure(ctx, error);
    }

    const flatPaths = batches.flat().map((change) => change.path);
    expect(flatPaths.some((changedPath) => changedPath.includes('dist'))).toBe(false);
    expect(metadataBatches).toContainEqual({ filteredChangeBoundaries: ['dist'] });
  });
});

// A run that skipped its subject is not a pass — see assertNoPlatformSkips.
afterAll(() => {
  assertNoPlatformSkips();
});
