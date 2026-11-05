import { beforeEach, describe, expect, it } from 'vitest';
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
