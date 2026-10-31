import { beforeEach, describe, expect, it } from 'vitest';
import { createFileExplorerStore } from '../../store';
import { FILE_EXPLORER_STORAGE_KEY, FILE_EXPLORER_STORAGE_VERSION } from '../persistence-constants';

const validSerializedState = {
  currentFolderId: null,
  expandedDirectoryPaths: [],
  folderAccessOrder: [],
  folderStates: {},
  quickFilter: 'restored-filter',
  selectedFilePaths: [],
};

/** The Explorer reads `localStorage` as its store is made, as it does when the app opens. */
const openExplorer = () => createFileExplorerStore();

function seedPersistedState(state: unknown, version: number = FILE_EXPLORER_STORAGE_VERSION): void {
  localStorage.setItem(FILE_EXPLORER_STORAGE_KEY, JSON.stringify({ state, version }));
}

describe('persisted explorer recovery notice', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('recovers a corrupt-shaped payload to empty state and records one discard notice', () => {
    seedPersistedState({
      filePath: '/Users/alice/secret-client/source.ts',
      folderStates: 'corrupt',
    });

    const store = openExplorer();

    expect(store.getState().currentFolderId).toBeNull();
    expect(store.getState().selectedFilePaths).toEqual(new Set());
    expect(store.getState().persistenceRecoveryNotice).toBe('persisted-state-discarded');
    expect(store.getState().consumePersistenceRecoveryNotice()).toBe(true);
    expect(store.getState().consumePersistenceRecoveryNotice()).toBe(false);
    expect(store.getState().persistenceRecoveryNotice).toBeNull();
  });

  it('recovers a corrupt nested folder snapshot instead of throwing during merge', () => {
    seedPersistedState({
      ...validSerializedState,
      currentFolderId: '/Users/alice/secret-client-project',
      folderStates: {
        '/Users/alice/secret-client-project': null,
      },
    });

    const store = openExplorer();

    expect(store.getState().currentFolderId).toBeNull();
    expect(store.getState().folderStates).toEqual({});
    expect(store.getState().persistenceRecoveryNotice).toBe('persisted-state-discarded');
  });

  it('salvages valid folders when one top-level container is malformed', () => {
    seedPersistedState({
      ...validSerializedState,
      currentFolderId: 'valid',
      folderAccessOrder: null,
      folderStates: {
        valid: { selectedFilePaths: ['valid|@|src/valid.ts'] },
      },
    });

    const store = openExplorer();

    expect(store.getState().currentFolderId).toBe('valid');
    expect(store.getState().folderStates['valid']?.selectedFilePaths).toEqual(
      new Set(['valid|@|src/valid.ts'])
    );
    expect(store.getState().folderAccessOrder).toEqual([]);
    expect(store.getState().persistenceRecoveryNotice).toBe('persisted-state-discarded');
  });

  it('clears a dangling current folder when the folder-state container is malformed', () => {
    seedPersistedState({
      ...validSerializedState,
      currentFolderId: 'dangling-folder',
      folderStates: null,
    });

    const store = openExplorer();

    expect(store.getState().currentFolderId).toBeNull();
    expect(store.getState().folderStates).toEqual({});
    expect(store.getState().persistenceRecoveryNotice).toBe('persisted-state-discarded');
  });

  it('removes folder references absent from a valid folder-state map', () => {
    seedPersistedState({
      ...validSerializedState,
      currentFolderId: 'dangling-folder',
      folderAccessOrder: ['dangling-folder', 'valid'],
      folderStates: {
        valid: { selectedFilePaths: ['valid|@|src/valid.ts'] },
      },
    });

    const store = openExplorer();

    expect(store.getState().currentFolderId).toBeNull();
    expect(store.getState().folderAccessOrder).toEqual(['valid']);
    expect(store.getState().folderStates['valid']?.selectedFilePaths).toEqual(
      new Set(['valid|@|src/valid.ts'])
    );
    expect(store.getState().persistenceRecoveryNotice).toBe('persisted-state-discarded');
  });

  it('recovers an unsupported-version payload to empty state and records a discard notice', () => {
    seedPersistedState(
      {
        ...validSerializedState,
        currentFolderId: '/Users/alice/future-client-project',
      },
      FILE_EXPLORER_STORAGE_VERSION + 1
    );

    const store = openExplorer();

    expect(store.getState().currentFolderId).toBeNull();
    expect(store.getState().persistenceRecoveryNotice).toBe('persisted-state-discarded');
  });

  it('silently resets a deliberately unsupported older version', () => {
    seedPersistedState(validSerializedState, FILE_EXPLORER_STORAGE_VERSION - 1);

    const store = openExplorer();

    expect(store.getState().quickFilter).not.toBe('restored-filter');
    expect(store.getState().persistenceRecoveryNotice).toBeNull();
  });

  it('rejects a null envelope state consistently', () => {
    localStorage.setItem(
      FILE_EXPLORER_STORAGE_KEY,
      JSON.stringify({ state: null, version: FILE_EXPLORER_STORAGE_VERSION })
    );

    const store = openExplorer();

    expect(store.getState().persistenceRecoveryNotice).toBe('persisted-state-discarded');
  });

  it('records a discard notice for a value that is not JSON, and the next change replaces it', () => {
    localStorage.setItem(
      FILE_EXPLORER_STORAGE_KEY,
      '{"filePath":"/Users/alice/secret-client/source.ts"'
    );

    const store = openExplorer();

    expect(store.getState().persistenceRecoveryNotice).toBe('persisted-state-discarded');
    store.getState().setQuickFilter('after-recovery');
    expect(localStorage.getItem(FILE_EXPLORER_STORAGE_KEY)).not.toContain('secret-client');
  });

  it('reports malformed nested folder selection containers while preserving valid folders', () => {
    seedPersistedState({
      ...validSerializedState,
      folderStates: {
        malformed: { selectedFilePaths: 'not-an-array' },
        valid: { selectedFilePaths: ['valid|@|src/valid.ts'] },
      },
    });

    const store = openExplorer();

    expect(store.getState().folderStates['malformed']).toBeUndefined();
    expect(store.getState().folderStates['valid']?.selectedFilePaths).toEqual(
      new Set(['valid|@|src/valid.ts'])
    );
    expect(store.getState().persistenceRecoveryNotice).toBe('persisted-state-discarded');
  });

  it('salvages canonical entries from top-level persisted arrays and reports corruption', () => {
    seedPersistedState({
      ...validSerializedState,
      selectedFilePaths: ['root-1|@|src/index.ts', null],
    });

    const store = openExplorer();

    expect(store.getState().selectedFilePaths).toEqual(new Set(['root-1|@|src/index.ts']));
    expect(store.getState().persistenceRecoveryNotice).toBe('persisted-state-discarded');
  });

  it('drops malformed persisted selection keys and records a visible discard notice', () => {
    seedPersistedState({
      ...validSerializedState,
      selectedFilePaths: [
        'root-1|@|src/index.ts',
        'persisted-path-without-prefix',
        '|@|src/missing-root.ts',
        'root-1|@|',
      ],
    });

    const store = openExplorer();

    expect(store.getState().selectedFilePaths).toEqual(new Set(['root-1|@|src/index.ts']));
    expect(store.getState().persistenceRecoveryNotice).toBe('persisted-state-discarded');
  });

  it('does not record a discard notice when no persisted state exists', () => {
    const store = openExplorer();

    expect(store.getState().persistenceRecoveryNotice).toBeNull();
  });

  it('reports same-version state with an invalid current folder identifier', () => {
    seedPersistedState({
      ...validSerializedState,
      currentFolderId: { rawPath: '/Users/alice/secret-client-project' },
    });

    const store = openExplorer();

    expect(store.getState().currentFolderId).toBeNull();
    expect(store.getState().persistenceRecoveryNotice).toBe('persisted-state-discarded');
  });

  it('hydrates valid state without recording a discard notice', () => {
    seedPersistedState(validSerializedState);

    const store = openExplorer();

    expect(store.getState().quickFilter).toBe('restored-filter');
    expect(store.getState().persistenceRecoveryNotice).toBeNull();
  });

  it('never hydrates a persisted recovery notice into ephemeral state', () => {
    seedPersistedState({
      ...validSerializedState,
      persistenceRecoveryNotice: 'persisted-state-discarded',
    });

    const store = openExplorer();

    expect(store.getState().quickFilter).toBe('restored-filter');
    expect(store.getState().persistenceRecoveryNotice).toBeNull();
  });
});
