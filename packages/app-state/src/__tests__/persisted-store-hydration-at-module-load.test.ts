import { DESKTOP_NATIVE_TOOL_IDS } from '@brainstrike/assistant-contract/tool-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BST-1645, the same bug class as BST-423 / #2086 (see
 * `import-settings-hydration-at-module-load.test.ts`).
 *
 * Every store below persists through SYNCHRONOUS storage, so zustand's persist
 * middleware resolves `hydrate()` inside `create(...)` — while the module-level
 * `export const useXStore = ...` binding is still in its temporal dead zone.
 * `onRehydrateStorage` fires there. A callback that reaches for its own store
 * binding throws a `ReferenceError` that zustand's `.catch` swallows: it simply
 * re-invokes the callback as `(undefined, error)`, so the logic never runs and
 * nothing is reported.
 *
 * These tests hydrate the way the app does — seed storage FIRST, then import
 * the module fresh — which is the only arrangement that can see the bug. Tests
 * that call `persist.rehydrate()` after module load run when the binding
 * already exists and stay green either way.
 */
describe('persisted store hydration at module load', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it('marks the logging preferences store hydrated during the module-load hydration', async () => {
    localStorage.setItem(
      'logging-preferences.v1',
      JSON.stringify({
        state: {
          preferences: {
            consoleLevel: 'debug',
            enableConsole: true,
            file: { enabled: false, maxFiles: 5, maxSizeMb: 10 },
            includeTimestamp: true,
            level: 'debug',
            redactPaths: [],
          },
        },
        version: 1,
      })
    );

    const { useLoggingPreferencesStore } = await import('../stores/logging-preferences-store');

    // Consumers gate on `hasHydrated` to avoid writing defaults over persisted
    // preferences. Stuck at `false`, the store looks permanently un-hydrated.
    expect(useLoggingPreferencesStore.getState().hasHydrated).toBe(true);
    expect(useLoggingPreferencesStore.getState().preferences.includeTimestamp).toBe(true);
  });

  it('sanitizes unknown native tool ids during the module-load hydration', async () => {
    const knownToolId = DESKTOP_NATIVE_TOOL_IDS[0];
    expect(knownToolId).toBeTypeOf('string');

    localStorage.setItem(
      'native-tool-preferences.v1',
      JSON.stringify({
        state: {
          toolStates: {
            // A tool id that no longer exists in the catalog, persisted at the
            // CURRENT version so `migrate` (which also sanitizes) never runs.
            brainstrike_retired_tool: false,
            [knownToolId as string]: false,
          },
        },
        version: 1,
      })
    );

    const { useNativeToolPreferencesStore } = await import(
      '../stores/native-tool-preferences-store'
    );

    expect(useNativeToolPreferencesStore.getState().toolStates).toEqual({
      [knownToolId as string]: false,
    });
  });

  it('remaps a dropped memory model target during the module-load hydration', async () => {
    localStorage.setItem(
      'assistant-memory-preferences.v1',
      JSON.stringify({
        state: {
          observationalMemory: {
            enabled: true,
            messageTokens: 4000,
            // Dropped in the 2026 frontier refresh, persisted at the CURRENT
            // version so `migrate` never runs.
            modelTarget: 'anthropic/claude-opus-4-5',
            observationTokens: 4000,
            retrievalMode: 'off',
            scope: 'thread',
          },
          semanticRecall: {
            embeddingModelTarget: 'local/embeddinggemma-300m',
            enabled: false,
            messageRange: 2,
            scope: 'thread',
            topK: 5,
          },
        },
        version: 2,
      })
    );

    const { useAssistantMemoryPreferencesStore } = await import(
      '../stores/assistant-memory-preferences-store'
    );
    const state = useAssistantMemoryPreferencesStore.getState();

    expect(state.observationalMemory.modelTarget).toBe('anthropic/claude-opus-4-8');
    expect(state.hasHydrated).toBe(true);
  });
  it('preserves edits made while an async (Electron) storage read is still pending on a first run', async () => {
    // Desktop: the storage bridge is promise-based, so hydration resolves AFTER
    // the store is usable. A first-run profile has no snapshot (`null`), and a
    // `merge` that spreads defaults over `currentState` would revert any edit
    // made before the IPC read completes.
    let resolveRead: ((value: string | null) => void) | undefined;
    const pendingRead = new Promise<string | null>((resolve) => {
      resolveRead = resolve;
    });
    const electronAPI = {
      storage: {
        getItem: () => pendingRead,
        removeItem: () => Promise.resolve(),
        setItem: () => Promise.resolve(),
      },
    };
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: electronAPI });
    try {
      const { useAssistantMemoryPreferencesStore } = await import(
        '../stores/assistant-memory-preferences-store'
      );
      const before = useAssistantMemoryPreferencesStore.getState();
      expect(before.hasHydrated).toBe(false);
      useAssistantMemoryPreferencesStore.setState({
        observationalMemory: { ...before.observationalMemory, messageTokens: 9999 },
      });

      resolveRead?.(null);
      await vi.waitFor(() =>
        expect(useAssistantMemoryPreferencesStore.getState().hasHydrated).toBe(true)
      );
      expect(useAssistantMemoryPreferencesStore.getState().observationalMemory.messageTokens).toBe(
        9999
      );
    } finally {
      Reflect.deleteProperty(window, 'electronAPI');
    }
  });
});
