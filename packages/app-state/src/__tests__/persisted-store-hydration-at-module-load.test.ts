import { DESKTOP_NATIVE_TOOL_IDS } from '@brainstrike/assistant-contract/tool-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BST-1645, the same bug class as BST-423 / #2086 (see
 * `token-preferences-store.ts`).
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

  it('sanitizes unknown native tool ids during the module-load hydration', async () => {
    const knownToolId = DESKTOP_NATIVE_TOOL_IDS[0];
    expect(knownToolId).toBeTypeOf('string');

    localStorage.setItem(
      'brainstrike:native-tool-preferences.v1',
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
      '../stores/native-tool-preferences-store.ts'
    );

    expect(useNativeToolPreferencesStore.getState().toolStates).toEqual({
      [knownToolId as string]: false,
    });
  });

  it('remaps a dropped memory model target during the module-load hydration', async () => {
    localStorage.setItem(
      'brainstrike:assistant-memory-preferences.v1',
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
        },
        version: 2,
      })
    );

    const { useAssistantMemoryPreferencesStore } = await import(
      '../stores/assistant-memory-preferences-store.ts'
    );
    const state = useAssistantMemoryPreferencesStore.getState();

    expect(state.observationalMemory.modelTarget).toBe('anthropic/claude-opus-4-8');
    expect(state.hasHydrated).toBe(true);
  });
});
