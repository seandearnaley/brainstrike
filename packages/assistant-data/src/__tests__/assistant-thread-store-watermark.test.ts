/**
 * The per-thread viewed watermark and the persisted-state migrate that carries
 * it (BST-1403).
 *
 * Split out of `assistant-thread-store.test.ts`, which crossed Biome's
 * 1000-line cap once BST-1441's stale-refresh cases landed alongside these —
 * neither set crossed it alone. Split rather than raising the cap, and split
 * HERE because the watermark is the store's only durable cross-session fact:
 * everything left behind is tab-session state, which is per-window and
 * discardable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  migrateAssistantThreadPersistedState,
  resetAssistantThreadStore,
  useAssistantThreadStore,
} from '../assistant-thread-store';
import { createRepository, workspaceId } from './helpers/assistant-thread-store-fixtures';

describe('per-thread viewed watermark', () => {
  beforeEach(() => {
    resetAssistantThreadStore();
  });

  it('records a watermark and never lowers an existing one', () => {
    const store = useAssistantThreadStore.getState();

    store.markThreadViewed('thread-a', 1000);
    expect(useAssistantThreadStore.getState().lastViewedAtByThreadId).toEqual({
      'thread-a': 1000,
    });

    store.markThreadViewed('thread-a', 500);
    expect(useAssistantThreadStore.getState().lastViewedAtByThreadId['thread-a']).toBe(1000);

    store.markThreadViewed('thread-a', 1000);
    expect(useAssistantThreadStore.getState().lastViewedAtByThreadId['thread-a']).toBe(1000);

    store.markThreadViewed('thread-a', 2000);
    expect(useAssistantThreadStore.getState().lastViewedAtByThreadId['thread-a']).toBe(2000);
  });

  it('defaults the watermark to now and rejects a blank thread id', () => {
    vi.spyOn(Date, 'now').mockReturnValue(4242);
    useAssistantThreadStore.getState().markThreadViewed('thread-a');
    expect(useAssistantThreadStore.getState().lastViewedAtByThreadId['thread-a']).toBe(4242);
    vi.mocked(Date.now).mockRestore();

    expect(() => useAssistantThreadStore.getState().markThreadViewed(' ')).toThrow(
      'Thread id is required.'
    );
  });

  it('prunes the watermark when threads are deleted', async () => {
    const repository = createRepository();
    await useAssistantThreadStore.getState().ensureResourceThreads(repository, workspaceId);
    const store = useAssistantThreadStore.getState();
    store.markThreadViewed('thread-a', 1000);
    store.markThreadViewed('thread-b', 2000);

    await useAssistantThreadStore.getState().deleteThread(repository, workspaceId, 'thread-a');
    expect(useAssistantThreadStore.getState().lastViewedAtByThreadId).toEqual({
      'thread-b': 2000,
    });

    await useAssistantThreadStore.getState().deleteThreads(repository, workspaceId, ['thread-b']);
    expect(useAssistantThreadStore.getState().lastViewedAtByThreadId).toEqual({});
  });

  it('persists the watermark and clears it on reset', async () => {
    const repository = createRepository();
    await useAssistantThreadStore.getState().ensureResourceThreads(repository, workspaceId);
    useAssistantThreadStore.getState().markThreadViewed('thread-a', 1000);

    const partialize = useAssistantThreadStore.persist.getOptions().partialize;
    if (!partialize) {
      throw new Error('expected a partialize');
    }
    expect(partialize(useAssistantThreadStore.getState())).toMatchObject({
      lastViewedAtByThreadId: { 'thread-a': 1000 },
    });

    resetAssistantThreadStore();
    expect(useAssistantThreadStore.getState().lastViewedAtByThreadId).toEqual({});
  });

  // One persisted number, stamped once, that answers "unseen since when" on a
  // store that has never viewed anything. It is part of the persisted slice —
  // a baseline that reset itself on every launch would re-open the storm on
  // the next one.
  it('persists an unseen baseline and re-stamps it on reset', () => {
    expect(typeof useAssistantThreadStore.getState().unseenBaselineAt).toBe('number');

    const partialize = useAssistantThreadStore.persist.getOptions().partialize;
    if (!partialize) {
      throw new Error('expected a partialize');
    }
    expect(partialize(useAssistantThreadStore.getState())).toMatchObject({
      unseenBaselineAt: useAssistantThreadStore.getState().unseenBaselineAt,
    });

    vi.spyOn(Date, 'now').mockReturnValue(9999);
    resetAssistantThreadStore();
    expect(useAssistantThreadStore.getState().unseenBaselineAt).toBe(9999);
    vi.mocked(Date.now).mockRestore();
  });

  it('fills only the new keys when migrating a version-3 blob', () => {
    vi.spyOn(Date, 'now').mockReturnValue(4242);
    const persisted = {
      activeThreadIdByResourceId: { [workspaceId]: 'thread-a' },
      draftRuntimeByThreadId: { 'thread-a': { model: 'gpt-5.2' } },
      openThreadIdsByResourceId: { [workspaceId]: ['thread-a'] },
      selectedThreadByResourceId: { [workspaceId]: 'thread-a' },
    };

    expect(migrateAssistantThreadPersistedState(persisted, 3)).toEqual({
      ...persisted,
      lastViewedAtByThreadId: {},
      unseenBaselineAt: 4242,
    });
    vi.mocked(Date.now).mockRestore();
  });

  // The upgrade stamp is what keeps an upgrading user's pre-existing threads
  // "already seen": the v3 blob carries no thread ids and no run timestamps, so
  // there is nothing to seed per-thread watermarks FROM, and without a baseline
  // every thread with a completed run would light up on first launch.
  it('stamps a numeric unseen baseline on the v3 -> v4 upgrade', () => {
    const before = Date.now();

    const migrated = migrateAssistantThreadPersistedState(
      { activeThreadIdByResourceId: {} },
      3
    ) as unknown as { readonly unseenBaselineAt: unknown };

    expect(typeof migrated.unseenBaselineAt).toBe('number');
    expect(migrated.unseenBaselineAt as number).toBeGreaterThanOrEqual(before);
  });

  it('passes a malformed blob through untouched instead of repairing it', () => {
    vi.spyOn(Date, 'now').mockReturnValue(4242);
    const malformed = { activeThreadIdByResourceId: 'not-a-record', junk: 1 };

    expect(migrateAssistantThreadPersistedState(malformed, 3)).toEqual({
      ...malformed,
      lastViewedAtByThreadId: {},
      unseenBaselineAt: 4242,
    });
    vi.mocked(Date.now).mockRestore();
  });

  it('rejects a blob from before the key was introduced instead of reviving it', () => {
    const persisted = {
      activeThreadIdByResourceId: { [workspaceId]: 'thread-a' },
    };

    expect(() => migrateAssistantThreadPersistedState(persisted, 1)).toThrow(
      'Unsupported persisted assistant thread state version: 1.'
    );
  });

  it('rejects a blob from a newer (downgrade) build instead of accepting it unchanged', () => {
    const persisted = {
      activeThreadIdByResourceId: { [workspaceId]: 'thread-a' },
      lastViewedAtByThreadId: { 'thread-a': 1000 },
    };

    expect(() => migrateAssistantThreadPersistedState(persisted, 5)).toThrow(
      'Unsupported persisted assistant thread state version: 5.'
    );
  });

  it('rejects a non-object persisted blob', () => {
    expect(() => migrateAssistantThreadPersistedState('not-an-object', 3)).toThrow(
      'Invalid persisted assistant thread state.'
    );
    expect(() => migrateAssistantThreadPersistedState(null, 3)).toThrow(
      'Invalid persisted assistant thread state.'
    );
  });
});
