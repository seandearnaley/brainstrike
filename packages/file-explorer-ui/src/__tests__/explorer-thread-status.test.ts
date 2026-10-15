import { describe, expect, it, vi } from 'vitest';
import {
  createExplorerThreadStatusStore,
  type ExplorerThreadFileStatus,
} from '../shell/explorer-thread-status';
import { THREAD_KIND_APPEARANCE } from './thread-kind-appearance.fixture';

const READ: ExplorerThreadFileStatus = {
  editedWithoutRead: false,
  freshness: 'unknown',
  gone: false,
  kinds: ['read'],
};

function snapshot(files: Record<string, ExplorerThreadFileStatus>, touchedPaths: string[] = []) {
  return {
    directories: new Map<string, number>(),
    files: new Map(Object.entries(files)),
    touchedPaths,
  };
}

describe('createExplorerThreadStatusStore', () => {
  it("keeps a file's status identity while its content is unchanged, so its row does not repaint", () => {
    const store = createExplorerThreadStatusStore(THREAD_KIND_APPEARANCE);
    store.publish(snapshot({ a: READ, b: READ }));
    const first = store.getFileStatus('a');
    const listener = vi.fn();
    store.subscribe(listener);

    store.publish(snapshot({ a: { ...READ }, b: { ...READ, freshness: 'changed' } }));

    expect(store.getFileStatus('a')).toBe(first);
    expect(store.getFileStatus('b')?.freshness).toBe('changed');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not notify for a publish that changes nothing', () => {
    const store = createExplorerThreadStatusStore(THREAD_KIND_APPEARANCE);
    store.publish(snapshot({ a: READ }, ['/w/a.ts']));
    const listener = vi.fn();
    store.subscribe(listener);
    store.publish(snapshot({ a: { ...READ, kinds: ['read'] } }, ['/w/a.ts']));
    expect(listener).not.toHaveBeenCalled();
  });

  it('drops files the thread no longer touched', () => {
    const store = createExplorerThreadStatusStore(THREAD_KIND_APPEARANCE);
    store.publish(snapshot({ a: READ, b: READ }, ['/w/a.ts', '/w/b.ts']));
    store.publish(snapshot({ a: READ }, ['/w/a.ts']));
    expect(store.getFileStatus('b')).toBeUndefined();
    expect(store.getTouchedPaths()).toEqual(['/w/a.ts']);
  });

  it('watches a key while any row shows it, and releases each watch once', () => {
    const store = createExplorerThreadStatusStore(THREAD_KIND_APPEARANCE);
    const listener = vi.fn();
    store.subscribeWatched(listener);
    const first = store.watch('a');
    const second = store.watch('a');
    expect(store.getWatchedKeys()).toEqual(new Set(['a']));
    expect(listener).toHaveBeenCalledTimes(1);

    first();
    first();
    expect(store.getWatchedKeys().has('a')).toBe(true);
    second();
    expect(store.getWatchedKeys().size).toBe(0);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
