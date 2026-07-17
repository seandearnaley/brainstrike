import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { fakeDir } from '../../__tests__/support/fake-handles';
import { createVaultHandleStore, NOTES_VAULT_IDB_NAME } from '../handle-store';

describe('createVaultHandleStore', () => {
  it('persists vault roots and lists them in insertion (addedAt) order', async () => {
    const store = createVaultHandleStore(new IDBFactory());

    await store.put({ addedAt: 2, handle: fakeDir('beta'), name: 'beta', rootId: 'r2' });
    await store.put({ addedAt: 1, handle: fakeDir('alpha'), name: 'alpha', rootId: 'r1' });

    const listed = await store.list();
    expect(listed.map((root) => root.rootId)).toEqual(['r1', 'r2']);
    expect(listed[0]).toMatchObject({ addedAt: 1, name: 'alpha' });
    expect(listed[0]?.handle).toBeDefined();
  });

  it('overwrites an existing rootId and removes roots', async () => {
    const store = createVaultHandleStore(new IDBFactory());

    await store.put({ addedAt: 1, handle: fakeDir('a'), name: 'a', rootId: 'r1' });
    await store.put({ addedAt: 5, handle: fakeDir('a-renamed'), name: 'a-renamed', rootId: 'r1' });
    await store.put({ addedAt: 2, handle: fakeDir('b'), name: 'b', rootId: 'r2' });
    await store.remove('r2');

    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: 'a-renamed', rootId: 'r1' });
  });

  it('throws explicitly when IndexedDB is unavailable (no silent fallback)', () => {
    expect(() => createVaultHandleStore(undefined)).toThrow(/IndexedDB/);
  });

  it('uses the documented database name so factory reset can wipe it', () => {
    expect(NOTES_VAULT_IDB_NAME).toBe('brainstrike-notes-vault');
  });
});
