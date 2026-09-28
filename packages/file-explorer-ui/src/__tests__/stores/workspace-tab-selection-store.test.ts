import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

    it('mounts a restored-but-never-mounted successor in the same transition', async () => {
      // A session restore mounts only the restored selection.
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          state: {
            openAppIds: ['context-explorer', 'changes', 'canvas'],
            selection: { appId: 'canvas', kind: 'app' },
          },
          version: 2,
        })
      );
      await rehydrate();
      expect(useWorkspaceTabSelectionStore.getState().mountedAppIds).toEqual(['canvas']);
      const listener = vi.fn();
      const unsubscribe = useWorkspaceTabSelectionStore.subscribe(listener);

      const successor = useWorkspaceTabSelectionStore.getState().closeApp('canvas');
      unsubscribe();

      expect(successor).toBe('changes');
      expect(listener).toHaveBeenCalledTimes(1);
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        appId: 'changes',
        kind: 'app',
      });
      expect(useWorkspaceTabSelectionStore.getState().mountedAppIds).toEqual(['canvas', 'changes']);
    });
  });

  describe('closeApps (atomic bulk close)', () => {
    function openFourApps(): void {
      const store = useWorkspaceTabSelectionStore.getState();
      store.openApp('changes');
      store.openApp('canvas');
      store.openApp('terminal');
    }

    function closeAppsCountingPublishes(appIds: readonly string[]): {
      readonly publishes: number;
      readonly successor: string | null;
    } {
      const listener = vi.fn();
      const unsubscribe = useWorkspaceTabSelectionStore.subscribe(listener);
      try {
        const successor = useWorkspaceTabSelectionStore.getState().closeApps(appIds);
        return { publishes: listener.mock.calls.length, successor };
      } finally {
        unsubscribe();
      }
    }

    it('keeps a selected app that survives, in one store transition', () => {
      openFourApps();
      useWorkspaceTabSelectionStore.getState().selectApp('canvas');

      const { publishes, successor } = closeAppsCountingPublishes(['changes', 'terminal']);

      expect(successor).toBeNull();
      expect(publishes).toBe(1);
      expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual([
        'context-explorer',
        'canvas',
      ]);
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        appId: 'canvas',
        kind: 'app',
      });
    });

    it('moves a closed selection to the next surviving app, like closeApp', () => {
      openFourApps();
      useWorkspaceTabSelectionStore.getState().selectApp('changes');

      const { publishes, successor } = closeAppsCountingPublishes(['changes', 'canvas']);

      expect(successor).toBe('terminal');
      expect(publishes).toBe(1);
      expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual([
        'context-explorer',
        'terminal',
      ]);
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        appId: 'terminal',
        kind: 'app',
      });
    });

    it('falls back to the last surviving app when nothing survives after the selection', () => {
      openFourApps();
      useWorkspaceTabSelectionStore.getState().selectApp('canvas');

      const { successor } = closeAppsCountingPublishes(['canvas', 'terminal']);

      expect(successor).toBe('changes');
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        appId: 'changes',
        kind: 'app',
      });
    });

    it('closing every open app yields the empty selection and a null successor', () => {
      openFourApps();

      const { successor } = closeAppsCountingPublishes([
        'context-explorer',
        'changes',
        'canvas',
        'terminal',
      ]);

      expect(successor).toBeNull();
      expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual([]);
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({ kind: 'empty' });
    });

    it('leaves a file selection alone and never shrinks the mounted set', () => {
      openFourApps();
      useWorkspaceTabSelectionStore.getState().selectFile('tab-1');
      const mountedBefore = useWorkspaceTabSelectionStore.getState().mountedAppIds;

      const { successor } = closeAppsCountingPublishes(['changes', 'canvas']);

      expect(successor).toBeNull();
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        kind: 'file',
        tabId: 'tab-1',
      });
      expect(useWorkspaceTabSelectionStore.getState().mountedAppIds).toBe(mountedBefore);
    });

    it('mounts a hydrated-but-never-mounted successor in the same transition', () => {
      // A thread-workspace hydrate mounts only the hydrated selection.
      useWorkspaceTabSelectionStore
        .getState()
        .hydrate(['context-explorer', 'changes', 'canvas', 'terminal'], {
          appId: 'changes',
          kind: 'app',
        });
      expect(useWorkspaceTabSelectionStore.getState().mountedAppIds).toEqual(['changes']);

      const { publishes, successor } = closeAppsCountingPublishes(['changes', 'canvas']);

      expect(successor).toBe('terminal');
      expect(publishes).toBe(1);
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        appId: 'terminal',
        kind: 'app',
      });
      expect(useWorkspaceTabSelectionStore.getState().mountedAppIds).toEqual([
        'changes',
        'terminal',
      ]);
    });

    it('is a no-op that publishes nothing when none of the ids is open', () => {
      const { publishes, successor } = closeAppsCountingPublishes(['changes', 'canvas']);

      expect(successor).toBeNull();
      expect(publishes).toBe(0);
      expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual(['context-explorer']);
    });
  });

  describe('mountedAppIds (session keep-alive tracking)', () => {
    it('seeds with the default selection app', () => {
      expect(useWorkspaceTabSelectionStore.getState().mountedAppIds).toEqual(['context-explorer']);
    });

    it('grows when an app is activated and never shrinks on close', () => {
      useWorkspaceTabSelectionStore.getState().openApp('canvas');
      useWorkspaceTabSelectionStore.getState().closeApp('canvas');
      expect(useWorkspaceTabSelectionStore.getState().mountedAppIds).toEqual([
        'context-explorer',
        'canvas',
      ]);
    });

    it('is not persisted, but rehydrating an app selection seeds it', async () => {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          state: {
            mountedAppIds: ['changes', 'canvas'],
            openAppIds: ['canvas'],
            selection: { appId: 'canvas', kind: 'app' },
          },
          version: 2,
        })
      );
      await rehydrate();
      expect(useWorkspaceTabSelectionStore.getState().mountedAppIds).toEqual(['canvas']);
    });

    it('rehydrating a file selection seeds an empty mounted set', async () => {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          state: { openAppIds: ['context-explorer'], selection: { kind: 'file', tabId: 't' } },
          version: 2,
        })
      );
      await rehydrate();
      expect(useWorkspaceTabSelectionStore.getState().mountedAppIds).toEqual([]);
    });

    it('reset restores the default mounted set', () => {
      useWorkspaceTabSelectionStore.getState().openApp('changes');
      useWorkspaceTabSelectionStore.getState().reset();
      expect(useWorkspaceTabSelectionStore.getState().mountedAppIds).toEqual(['context-explorer']);
    });
  });

  describe('hydrate (thread-workspace coordinator entry point)', () => {
    it('replaces openAppIds and selection atomically and seeds mounted from the selection', () => {
      useWorkspaceTabSelectionStore.getState().openApp('changes');
      useWorkspaceTabSelectionStore
        .getState()
        .hydrate(['canvas'], { appId: 'canvas', kind: 'app' });
      expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual(['canvas']);
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        appId: 'canvas',
        kind: 'app',
      });
      expect(useWorkspaceTabSelectionStore.getState().mountedAppIds).toEqual(['canvas']);
    });

    it('hydrating a file selection appends its app-less mounted set from scratch', () => {
      useWorkspaceTabSelectionStore.getState().hydrate(['context-explorer'], {
        kind: 'file',
        tabId: 't1',
      });
      expect(useWorkspaceTabSelectionStore.getState().mountedAppIds).toEqual([]);
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        kind: 'file',
        tabId: 't1',
      });
    });

    it('coerces an app selection missing from openAppIds by appending it', () => {
      useWorkspaceTabSelectionStore.getState().hydrate([], { appId: 'changes', kind: 'app' });
      expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual(['changes']);
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
