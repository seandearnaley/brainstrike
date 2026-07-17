import { describe, expect, it, vi } from 'vitest';
import { fakeDir, fakeNote } from '../../__tests__/support/fake-handles';
import { createMemoryHandleStore } from '../../__tests__/support/memory-handle-store';
import { createNotesVaultStore, type NotesVaultServices } from '../../store/notes-vault-store';
import { buildVaultLocalActions, vaultRowToTarget } from '../vault-context-actions';

function testStore() {
  let idCounter = 0;
  const services: NotesVaultServices = {
    createWatcher: () => ({ disconnect: () => undefined }),
    handleStore: createMemoryHandleStore(),
    newRootId: () => `root-${++idCounter}`,
    now: () => idCounter,
    pickDirectory: () => Promise.reject(new DOMException('canceled', 'AbortError')),
    rescanDebounceMs: 0,
  };
  return createNotesVaultStore(services);
}

describe('vaultRowToTarget', () => {
  it('maps row data to discriminated targets', () => {
    expect(
      vaultRowToTarget({
        kind: 'note',
        node: {
          handle: fakeNote('a.md'),
          id: 'r1:a.md',
          lastModified: 0,
          name: 'a.md',
          pathSegments: ['a.md'],
          rootId: 'r1',
          size: 0,
          type: 'note',
        },
      })
    ).toEqual({ id: 'r1:a.md', kind: 'vault-note', name: 'a.md' });

    expect(
      vaultRowToTarget({
        kind: 'root',
        root: {
          builtIn: true,
          handle: fakeDir('vault'),
          name: 'My Notes',
          nodes: [],
          noteCount: 0,
          rootId: 'r1',
          status: 'ready',
        },
      })
    ).toEqual({ builtIn: true, id: 'r1', kind: 'vault-root', name: 'My Notes' });
  });
});

describe('buildVaultLocalActions', () => {
  const NOTE_TARGET = { id: 'r1:projects/a.md', kind: 'vault-note', name: 'a.md' } as const;
  const FOLDER_TARGET = { id: 'r1:projects', kind: 'vault-folder', name: 'projects' } as const;
  const ROOT_TARGET = { builtIn: false, id: 'r1', kind: 'vault-root', name: 'vault' } as const;

  function actionsWith(overrides: Partial<Parameters<typeof buildVaultLocalActions>[0]> = {}) {
    return buildVaultLocalActions({
      openDeleteDialog: vi.fn(),
      openNameDialog: vi.fn(),
      store: testStore(),
      ...overrides,
    });
  }

  it('gates actions by target kind', () => {
    const actions = actionsWith();
    const byId = new Map(actions.map((action) => [action.id, action]));

    expect(byId.get('vault.new-note')?.appliesTo).toEqual(
      expect.arrayContaining(['vault-folder', 'vault-root'])
    );
    expect(byId.get('vault.rename')?.appliesTo).toEqual(
      expect.arrayContaining(['vault-note', 'vault-folder'])
    );
    expect(byId.get('vault.delete')?.appliesTo).toEqual(
      expect.arrayContaining(['vault-note', 'vault-folder'])
    );
    expect(byId.get('vault.delete')?.group).toBe('danger');
  });

  it('new note runs the store action directly', async () => {
    const store = testStore();
    const createNote = vi.spyOn(store.getState(), 'createNote').mockResolvedValue();
    const actions = actionsWith({ store });
    const action = actions.find((a) => a.id === 'vault.new-note');

    const outcome = await action?.run(FOLDER_TARGET, {} as never);

    expect(outcome).toEqual({ ok: true });
    expect(createNote).toHaveBeenCalledWith('r1:projects');
  });

  it('new folder / rename stage into the name dialog; delete stages into confirm', async () => {
    const openNameDialog = vi.fn();
    const openDeleteDialog = vi.fn();
    const actions = actionsWith({ openDeleteDialog, openNameDialog });

    await actions.find((a) => a.id === 'vault.new-folder')?.run(ROOT_TARGET, {} as never);
    expect(openNameDialog).toHaveBeenCalledWith({
      containerId: 'r1',
      kind: 'new-folder',
    });

    await actions.find((a) => a.id === 'vault.rename')?.run(NOTE_TARGET, {} as never);
    expect(openNameDialog).toHaveBeenCalledWith({
      currentName: 'a.md',
      entryId: 'r1:projects/a.md',
      entryKind: 'note',
      kind: 'rename',
    });

    await actions.find((a) => a.id === 'vault.delete')?.run(FOLDER_TARGET, {} as never);
    expect(openDeleteDialog).toHaveBeenCalledWith({
      entryId: 'r1:projects',
      entryKind: 'folder',
      name: 'projects',
    });
  });
});
