import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetWorkspaceTabSelectionStoreForTests,
  useWorkspaceTabSelectionStore,
} from '../../stores/workspace-tab-selection-store';

const STORE_KEY = 'workspace-tab-selection.v1';

async function rehydrate() {
  const persistApi = (
    useWorkspaceTabSelectionStore as unknown as {
      persist?: { rehydrate?: () => Promise<void> };
    }
  ).persist;
  await persistApi?.rehydrate?.();
}

describe('workspace-tab-selection-store', () => {
  beforeEach(() => {
    __resetWorkspaceTabSelectionStoreForTests();
    try {
      localStorage.removeItem(STORE_KEY);
    } catch {}
  });

  afterEach(() => {
    __resetWorkspaceTabSelectionStoreForTests();
  });

  it('defaults to the Context Explorer app selection', () => {
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      appId: 'context-explorer',
      kind: 'app',
    });
  });

  it('persists and restores a file selection', async () => {
    useWorkspaceTabSelectionStore.getState().selectFile('folderA|@|src/index.ts');
    await rehydrate();
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      kind: 'file',
      tabId: 'folderA|@|src/index.ts',
    });
  });

  it('coerces a malformed file selection (missing tabId) back to the default', async () => {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ state: { selection: { kind: 'file' } }, version: 1 })
    );
    await rehydrate();
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      appId: 'context-explorer',
      kind: 'app',
    });
  });

  it('coerces a malformed app selection (missing appId) back to the default', async () => {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ state: { selection: { kind: 'app' } }, version: 1 })
    );
    await rehydrate();
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      appId: 'context-explorer',
      kind: 'app',
    });
  });

  it('coerces a totally garbage payload back to the default', async () => {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ state: { selection: { goblin: true, kind: 'wat' } }, version: 1 })
    );
    await rehydrate();
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      appId: 'context-explorer',
      kind: 'app',
    });
  });
});
