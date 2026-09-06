import type { StorageThreadType } from '@mastra/core/memory';
import { describe, expect, it } from 'vitest';
import {
  attachThreadTitleSaveAbortSignal,
  throwIfThreadTitleSaveAborted,
} from '../thread-title-save-cancellation';

function makeThread(): StorageThreadType {
  const timestamp = new Date('2026-08-24T12:00:00.000Z');
  return {
    createdAt: timestamp,
    id: 'thread-title-save-cancellation',
    resourceId: 'resource-title-save-cancellation',
    title: 'Generated title',
    updatedAt: timestamp,
  };
}

describe('thread title save cancellation', () => {
  it('keeps the process-local signal out of Mastra persistence payloads', () => {
    const thread = attachThreadTitleSaveAbortSignal(makeThread(), new AbortController().signal);

    expect(Object.keys(thread)).not.toContain('brainstrike.thread-title-save-abort-signal');
    expect(() => throwIfThreadTitleSaveAborted(thread)).not.toThrow();
  });

  it('normalizes an aborted non-Error reason at the transactional boundary', () => {
    const thread = attachThreadTitleSaveAbortSignal(makeThread(), AbortSignal.abort('expired'));

    expect(() => throwIfThreadTitleSaveAborted(thread)).toThrow(
      'Mastra thread title persistence deadline expired.'
    );
  });
});
