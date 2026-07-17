import { describe, expect, it, vi } from 'vitest';
import { fakeNote } from '../../__tests__/support/fake-handles';
import type { VaultFileHandleLike } from '../../core/types';
import {
  clearNoteContentCache,
  ensureNoteContent,
  getNoteContentSnapshot,
  subscribeNoteContent,
} from '../note-content-store';

async function settled(contentKey: string): Promise<void> {
  await vi.waitFor(() => {
    expect(getNoteContentSnapshot(contentKey).status).not.toBe('loading');
  });
}

describe('note-content-store', () => {
  it('reads a note once per content key and serves the cache afterwards', async () => {
    const handle = fakeNote('a.md', { content: 'body' });
    const getFile = vi.spyOn(handle, 'getFile');

    ensureNoteContent('k1@1', handle);
    await settled('k1@1');
    ensureNoteContent('k1@1', handle);

    expect(getNoteContentSnapshot('k1@1')).toEqual({ content: 'body', status: 'ready' });
    expect(getFile).toHaveBeenCalledTimes(1);
  });

  it('re-reads under a new lastModified key (external edit)', async () => {
    const handle = fakeNote('b.md', { content: 'v1' });

    ensureNoteContent('k2@1', handle);
    await settled('k2@1');
    handle.state.content = 'v2';
    ensureNoteContent('k2@2', handle);
    await settled('k2@2');

    expect(getNoteContentSnapshot('k2@2')).toEqual({ content: 'v2', status: 'ready' });
  });

  it('does not pin transient read failures — the next ensure retries', async () => {
    const handle = fakeNote('c.md', { content: 'recovered' });
    const getFile = vi
      .spyOn(handle, 'getFile')
      .mockRejectedValueOnce(new DOMException('locked', 'NotReadableError'));

    ensureNoteContent('k3@1', handle);
    await settled('k3@1');
    expect(getNoteContentSnapshot('k3@1').status).toBe('error');

    ensureNoteContent('k3@1', handle);
    await settled('k3@1');

    expect(getNoteContentSnapshot('k3@1')).toEqual({ content: 'recovered', status: 'ready' });
    expect(getFile).toHaveBeenCalledTimes(2);
  });

  it('bounds the cache even when reads fail', async () => {
    const failing: VaultFileHandleLike = {
      createWritable: () => Promise.reject(new Error('unused')),
      getFile: () => Promise.reject(new Error('boom')),
      isSameEntry: () => Promise.resolve(false),
      kind: 'file',
      name: 'x.md',
    };
    for (let index = 0; index < 40; index += 1) {
      ensureNoteContent(`evict@${index}`, failing);
    }
    await settled('evict@39');

    // The earliest keys must have been evicted (bound is 32).
    await vi.waitFor(() => {
      expect(getNoteContentSnapshot('evict@0').status).toBe('loading');
    });
  });

  it('clearNoteContentCache drops cached plaintext (factory-reset contract)', async () => {
    const handle = fakeNote('reset.md', { content: 'sensitive' });
    ensureNoteContent('k6@1', handle);
    await settled('k6@1');
    expect(getNoteContentSnapshot('k6@1').status).toBe('ready');

    clearNoteContentCache();

    expect(getNoteContentSnapshot('k6@1').status).toBe('loading');
  });

  it('notifies subscribers when a load settles', async () => {
    const handle = fakeNote('d.md', { content: 'ping' });
    const listener = vi.fn();
    const unsubscribe = subscribeNoteContent(listener);

    ensureNoteContent('k5@1', handle);
    await settled('k5@1');
    unsubscribe();

    expect(listener).toHaveBeenCalled();
  });
});
