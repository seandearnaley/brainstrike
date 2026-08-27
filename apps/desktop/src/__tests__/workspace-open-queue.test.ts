import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkspaceOpenQueue,
  filterDirectoryOpenCandidates,
  MAX_PENDING_OPEN_REQUESTS,
  type WorkspaceOpenDeliveryTarget,
} from '../workspace-open-queue';

const CHANNEL = 'workspace:open-path';

function makeTarget(
  overrides?: Partial<WorkspaceOpenDeliveryTarget>
): WorkspaceOpenDeliveryTarget & {
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn();
  return {
    isDestroyed: () => false,
    send,
    ...overrides,
  } as WorkspaceOpenDeliveryTarget & { send: ReturnType<typeof vi.fn> };
}

describe('createWorkspaceOpenQueue', () => {
  let queue: ReturnType<typeof createWorkspaceOpenQueue>;

  beforeEach(() => {
    queue = createWorkspaceOpenQueue(CHANNEL);
  });

  it('delivers a request enqueued before attach exactly once, in order, after attach', () => {
    queue.enqueue({ origin: 'open-file', path: '/work/repo-a' });
    queue.enqueue({ origin: 'argv', path: '/work/repo-b' });
    const target = makeTarget();

    queue.attach(target);

    expect(target.send).toHaveBeenCalledTimes(2);
    expect(target.send).toHaveBeenNthCalledWith(1, CHANNEL, {
      origin: 'open-file',
      path: '/work/repo-a',
    });
    expect(target.send).toHaveBeenNthCalledWith(2, CHANNEL, {
      origin: 'argv',
      path: '/work/repo-b',
    });
  });

  it('delivers a request enqueued after attach immediately', () => {
    const target = makeTarget();
    queue.attach(target);

    queue.enqueue({ origin: 'menu-recent', path: '/work/repo-c' });

    expect(target.send).toHaveBeenCalledExactlyOnceWith(CHANNEL, {
      origin: 'menu-recent',
      path: '/work/repo-c',
    });
  });

  it('drops nothing when the attached webContents is destroyed — the request stays queued', () => {
    const destroyedTarget = makeTarget({ isDestroyed: () => true });
    queue.attach(destroyedTarget);
    queue.enqueue({ origin: 'open-file', path: '/work/repo-d' });

    expect(destroyedTarget.send).not.toHaveBeenCalled();

    const liveTarget = makeTarget();
    queue.attach(liveTarget);

    expect(liveTarget.send).toHaveBeenCalledExactlyOnceWith(CHANNEL, {
      origin: 'open-file',
      path: '/work/repo-d',
    });
  });

  it('attaching a second window does not re-deliver already-delivered requests', () => {
    const firstTarget = makeTarget();
    queue.attach(firstTarget);
    queue.enqueue({ origin: 'open-file', path: '/work/repo-e' });
    expect(firstTarget.send).toHaveBeenCalledTimes(1);

    const secondTarget = makeTarget();
    queue.attach(secondTarget);

    expect(secondTarget.send).not.toHaveBeenCalled();
  });

  it('bounds the queue and drops the OLDEST pending request with a warn', () => {
    for (let i = 0; i < MAX_PENDING_OPEN_REQUESTS; i++) {
      queue.enqueue({ origin: 'second-instance', path: `/work/repo-${i}` });
    }
    // One more than the bound: the oldest (repo-0) must be dropped.
    queue.enqueue({ origin: 'second-instance', path: '/work/repo-overflow' });

    const target = makeTarget();
    queue.attach(target);

    expect(target.send).toHaveBeenCalledTimes(MAX_PENDING_OPEN_REQUESTS);
    expect(target.send).not.toHaveBeenCalledWith(CHANNEL, {
      origin: 'second-instance',
      path: '/work/repo-0',
    });
    expect(target.send).toHaveBeenNthCalledWith(1, CHANNEL, {
      origin: 'second-instance',
      path: '/work/repo-1',
    });
    expect(target.send).toHaveBeenNthCalledWith(MAX_PENDING_OPEN_REQUESTS, CHANNEL, {
      origin: 'second-instance',
      path: '/work/repo-overflow',
    });
  });

  it('reset() empties the queue', () => {
    queue.enqueue({ origin: 'open-file', path: '/work/repo-f' });
    queue.reset();

    const target = makeTarget();
    queue.attach(target);

    expect(target.send).not.toHaveBeenCalled();
  });

  it('detach() clears the target so a mid-reload enqueue buffers instead of sending into a listener-less page', () => {
    const target = makeTarget();
    queue.attach(target);

    queue.detach();
    queue.enqueue({ origin: 'open-file', path: '/work/repo-g' });

    // The request must NOT have been sent into the (now presumed reloading)
    // page — that would be exactly the mid-reload loss the review flagged.
    expect(target.send).not.toHaveBeenCalled();

    // The following did-finish-load re-attach delivers it.
    queue.attach(target);
    expect(target.send).toHaveBeenCalledExactlyOnceWith(CHANNEL, {
      origin: 'open-file',
      path: '/work/repo-g',
    });
  });

  it('detach() with no target attached is a safe no-op', () => {
    expect(() => queue.detach()).not.toThrow();
  });
});

describe('filterDirectoryOpenCandidates', () => {
  let tempDir: string;
  let tempFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-open-queue-test-'));
    tempFile = path.join(tempDir, 'not-a-directory.txt');
    fs.writeFileSync(tempFile, 'content');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  it('keeps a real, readable directory', () => {
    expect(filterDirectoryOpenCandidates([tempDir], 'open-file')).toEqual([tempDir]);
  });

  it('skips a FILE path — the routine macOS "Open With…" case, never enqueued', () => {
    expect(filterDirectoryOpenCandidates([tempFile], 'open-file')).toEqual([]);
  });

  it('skips a path that does not exist, without throwing', () => {
    const missing = path.join(tempDir, 'does-not-exist');
    expect(() => filterDirectoryOpenCandidates([missing], 'argv')).not.toThrow();
    expect(filterDirectoryOpenCandidates([missing], 'argv')).toEqual([]);
  });

  it('filters a mixed batch, preserving order of the survivors', () => {
    const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-open-queue-test-'));
    try {
      expect(
        filterDirectoryOpenCandidates([tempFile, tempDir, secondDir], 'second-instance')
      ).toEqual([tempDir, secondDir]);
    } finally {
      fs.rmSync(secondDir, { force: true, recursive: true });
    }
  });
});
