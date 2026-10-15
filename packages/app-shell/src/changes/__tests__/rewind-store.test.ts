// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { useChangesStore } from '../changes-store';
import type { RewindPort } from '../rewind-port';
import { useRewindStore } from '../rewind-store';

/** A port no test here calls: the store only holds it. */
const PORT: RewindPort = {
  apply: () => Promise.reject(new Error('not used')),
  conversation: 'branched',
  fileDiff: () => Promise.reject(new Error('not used')),
  preview: () => Promise.reject(new Error('not used')),
  redo: () => Promise.reject(new Error('not used')),
};

const REQUEST = {
  composerText: 'my original prompt',
  port: PORT,
  target: { messageId: 'msg-2', threadId: 'thread-1' },
} as const;

beforeEach(() => {
  useRewindStore.getState().reset();
  useChangesStore.getState().reset();
});

describe('useRewindStore', () => {
  it('starts closed', () => {
    expect(useRewindStore.getState().request).toBeNull();
  });

  it('holds the raised request until it is closed', () => {
    useRewindStore.getState().openRewind(REQUEST);
    expect(useRewindStore.getState().request).toEqual(REQUEST);

    useRewindStore.getState().closeRewind();
    expect(useRewindStore.getState().request).toBeNull();
  });

  it('accepts a run target as well as a message target', () => {
    useRewindStore.getState().openRewind({
      composerText: null,
      port: PORT,
      target: { runId: 'run-1', threadId: 'thread-1' },
    });

    expect(useRewindStore.getState().request?.target).toEqual({
      runId: 'run-1',
      threadId: 'thread-1',
    });
  });

  // The modal reuses the Changes surface's tree/diff panes, which agree on the
  // SHARED file selection. Without clearing on both edges, a file checked
  // inside the modal keeps filtering the surface behind it — over a tree of
  // visibly unchecked boxes, because the surface only clears when its own
  // changeset changes and it did not change.
  it('clears the shared file selection on BOTH edges', () => {
    useChangesStore.getState().setSelectedFileKeys(new Set(['root-1\u0000\u0000src/a.ts']));
    expect(useChangesStore.getState().hasExplicitSelection).toBe(true);

    useRewindStore.getState().openRewind(REQUEST);
    expect(useChangesStore.getState().hasExplicitSelection).toBe(false);

    useChangesStore.getState().setSelectedFileKeys(new Set(['root-1\u0000\u0000src/b.ts']));
    useRewindStore.getState().closeRewind();
    expect(useChangesStore.getState().selectedFileKeys.size).toBe(0);
  });

  it('reset() drops an open request (factory reset)', () => {
    useRewindStore.getState().openRewind(REQUEST);

    useRewindStore.getState().reset();

    expect(useRewindStore.getState().request).toBeNull();
  });
});

describe('useRewindStore — the re-hydration generation', () => {
  it('starts at 0 and only moves forward', () => {
    expect(useRewindStore.getState().generation).toBe(0);

    useRewindStore.getState().markRewindApplied();
    useRewindStore.getState().markRewindApplied();

    expect(useRewindStore.getState().generation).toBe(2);
  });

  // Consumers key a React remount on this number. Raising and closing the modal
  // must not remount the assistant runtime — only a rewind that actually
  // changed durable state may.
  it('is untouched by opening or closing the modal', () => {
    useRewindStore.getState().markRewindApplied();

    useRewindStore.getState().openRewind(REQUEST);
    useRewindStore.getState().closeRewind();

    expect(useRewindStore.getState().generation).toBe(1);
  });

  it('reset() returns to 0 (factory reset wipes what the counter re-reads)', () => {
    useRewindStore.getState().markRewindApplied();

    useRewindStore.getState().reset();

    expect(useRewindStore.getState().generation).toBe(0);
  });
});
