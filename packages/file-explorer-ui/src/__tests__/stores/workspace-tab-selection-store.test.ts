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

  it('defaults openAppIds to the Context Explorer app', () => {
    expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual(['context-explorer']);
  });

  describe('openApp / selectApp singleton semantics', () => {
    it('adds the app once and selects it', () => {
      const state = useWorkspaceTabSelectionStore.getState();
      state.openApp('changes');
      useWorkspaceTabSelectionStore.getState().openApp('changes');
      expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual([
        'context-explorer',
        'changes',
      ]);
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        appId: 'changes',
        kind: 'app',
      });
    });

    it('selectApp behaves identically to openApp (adds if missing)', () => {
      useWorkspaceTabSelectionStore.getState().selectApp('canvas');
      expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual([
        'context-explorer',
        'canvas',
      ]);
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        appId: 'canvas',
        kind: 'app',
      });
    });
  });

  describe('closeApp', () => {
    it('selects the adjacent open app and returns it', () => {
      useWorkspaceTabSelectionStore.getState().openApp('changes');
      useWorkspaceTabSelectionStore.getState().openApp('canvas');
      const successor = useWorkspaceTabSelectionStore.getState().closeApp('canvas');
      expect(successor).toBe('changes');
      expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual([
        'context-explorer',
        'changes',
      ]);
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        appId: 'changes',
        kind: 'app',
      });
    });

    it('prefers the next app (same index after removal) over the previous one', () => {
      useWorkspaceTabSelectionStore.getState().openApp('changes');
      useWorkspaceTabSelectionStore.getState().openApp('canvas');
      useWorkspaceTabSelectionStore.getState().selectApp('changes');
      const successor = useWorkspaceTabSelectionStore.getState().closeApp('changes');
      expect(successor).toBe('canvas');
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        appId: 'canvas',
        kind: 'app',
      });
    });

    it('closing the last open app yields empty selection and null successor', () => {
      const successor = useWorkspaceTabSelectionStore.getState().closeApp('context-explorer');
      expect(successor).toBeNull();
      expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual([]);
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({ kind: 'empty' });
    });

    it('closing a background app leaves the current selection alone', () => {
      useWorkspaceTabSelectionStore.getState().openApp('changes');
      useWorkspaceTabSelectionStore.getState().selectFile('tab-1');
      const successor = useWorkspaceTabSelectionStore.getState().closeApp('changes');
      expect(successor).toBeNull();
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        kind: 'file',
        tabId: 'tab-1',
      });
      expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual(['context-explorer']);
    });

    it('closing an app that is not open is a no-op returning null', () => {
      const successor = useWorkspaceTabSelectionStore.getState().closeApp('changes');
      expect(successor).toBeNull();
      expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual(['context-explorer']);
    });
  });

  describe('selectEmpty / reset', () => {
    it('selectEmpty sets the empty selection', () => {
      useWorkspaceTabSelectionStore.getState().selectEmpty();
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({ kind: 'empty' });
    });

    it('reset restores defaults', () => {
      useWorkspaceTabSelectionStore.getState().openApp('changes');
      useWorkspaceTabSelectionStore.getState().selectEmpty();
      useWorkspaceTabSelectionStore.getState().reset();
      expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual(['context-explorer']);
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        appId: 'context-explorer',
        kind: 'app',
      });
    });
  });

  describe('v2 persistence', () => {
    it('persists and restores openAppIds and selection together', async () => {
      useWorkspaceTabSelectionStore.getState().openApp('canvas');
      await rehydrate();
      expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual([
        'context-explorer',
        'canvas',
      ]);
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        appId: 'canvas',
        kind: 'app',
      });
    });

    it('persists and restores the empty selection (no default resurrection)', async () => {
      useWorkspaceTabSelectionStore.getState().closeApp('context-explorer');
      await rehydrate();
      expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual([]);
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({ kind: 'empty' });
    });

    it('migrates a v1 payload, seeding openAppIds with context-explorer', async () => {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          state: { selection: { kind: 'file', tabId: 'folderA|@|src/index.ts' } },
          version: 1,
        })
      );
      await rehydrate();
      expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual(['context-explorer']);
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        kind: 'file',
        tabId: 'folderA|@|src/index.ts',
      });
    });

    it('migrating a v1 app selection includes that app in openAppIds', async () => {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({ state: { selection: { appId: 'canvas', kind: 'app' } }, version: 1 })
      );
      await rehydrate();
      expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual([
        'context-explorer',
        'canvas',
      ]);
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        appId: 'canvas',
        kind: 'app',
      });
    });

    it('coerces an app selection whose id is missing from openAppIds (appends it)', async () => {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          state: { openAppIds: [], selection: { appId: 'canvas', kind: 'app' } },
          version: 2,
        })
      );
      await rehydrate();
      expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual(['canvas']);
    });

    it('coerces garbage openAppIds (non-array, non-string entries, duplicates) to a sane list', async () => {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          state: {
            openAppIds: ['changes', 42, 'changes', null],
            selection: { appId: 'changes', kind: 'app' },
          },
          version: 2,
        })
      );
      await rehydrate();
      expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual(['changes']);
    });

    it('falls back to full defaults on a completely garbage v2 payload', async () => {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({ state: { openAppIds: 'nope', selection: 42 }, version: 2 })
      );
      await rehydrate();
      expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual(['context-explorer']);
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        appId: 'context-explorer',
        kind: 'app',
      });
    });
  });
});
