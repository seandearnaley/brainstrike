import { DESKTOP_NATIVE_TOOL_IDS } from '@brainstrike/assistant-contract/tool-metadata';
import { persistDurable } from '@brainstrike/storage';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { createSanitizedPersistMerge } from './sanitized-persist-merge.ts';

type NativeToolStateMap = Record<string, boolean>;

interface NativeToolPreferencesData {
  toolStates: NativeToolStateMap;
}

interface NativeToolPreferencesActions {
  isToolEnabled: (toolId: string) => boolean;
  resetTools: () => void;
  setToolEnabled: (toolId: string, enabled: boolean) => void;
  setToolsEnabled: (toolIds: string[], enabled: boolean) => void;
}

export type NativeToolPreferencesStore = NativeToolPreferencesData & NativeToolPreferencesActions;

const STORE_NAME = 'brainstrike:native-tool-preferences.v1' as const;

const KNOWN_NATIVE_TOOL_IDS = new Set<string>(DESKTOP_NATIVE_TOOL_IDS);

function sanitizeToolStates(value: unknown): NativeToolStateMap {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const cleaned: NativeToolStateMap = {};

  for (const [toolId, enabled] of entries) {
    if (!KNOWN_NATIVE_TOOL_IDS.has(toolId)) {
      continue;
    }
    if (typeof enabled === 'boolean') {
      cleaned[toolId] = enabled;
    }
  }

  return cleaned;
}

function resolveToolEnabled(toolId: string, states: NativeToolStateMap): boolean {
  const value = states[toolId];
  return typeof value === 'boolean' ? value : true;
}

export const useNativeToolPreferencesStore = create<NativeToolPreferencesStore>()(
  persistDurable(
    STORE_NAME,
    (set, get) => ({
      isToolEnabled: (toolId: string) => resolveToolEnabled(toolId, get().toolStates),
      resetTools: () => set({ toolStates: {} }),
      setToolEnabled: (toolId, enabled) =>
        set((state) => {
          const next = { ...state.toolStates };
          if (enabled) {
            delete next[toolId];
          } else {
            next[toolId] = false;
          }
          return { toolStates: next };
        }),
      setToolsEnabled: (toolIds, enabled) =>
        set((state) => {
          if (toolIds.length === 0) {
            return state;
          }
          const next = { ...state.toolStates };
          for (const toolId of toolIds) {
            if (enabled) {
              delete next[toolId];
            } else {
              next[toolId] = false;
            }
          }
          return { toolStates: next };
        }),
      toolStates: {},
    }),
    {
      /**
       * BST-1645: the sanitize runs HERE, not in `onRehydrateStorage`.
       *
       * `createNativeToolPreferencesStorage().getItem` is synchronous, so
       * zustand's persist middleware resolves hydration DURING `create(...)` —
       * while the module-level `useNativeToolPreferencesStore` binding is still
       * in its temporal dead zone. The old rehydrate callback called
       * `useNativeToolPreferencesStore.setState` and threw a ReferenceError
       * that zustand swallowed (it re-invokes the callback with
       * `state === undefined`, which then returns early), so retired tool ids
       * persisted at the CURRENT version were never dropped: `migrate` only
       * runs on a version mismatch. Same bug as #2086; see
       * `token-preferences-store.ts`.
       */
      merge: createSanitizedPersistMerge<NativeToolPreferencesStore, NativeToolPreferencesData>(
        (persistedState) => ({
          toolStates: sanitizeToolStates(
            (persistedState as { toolStates?: unknown } | undefined)?.toolStates
          ),
        })
      ),
      migrate: (state) => {
        const snapshot = state as Partial<NativeToolPreferencesStore> | undefined;
        return {
          ...snapshot,
          toolStates: sanitizeToolStates(snapshot?.toolStates),
        } satisfies Partial<NativeToolPreferencesStore>;
      },
      partialize: (store) => ({
        toolStates: store.toolStates,
      }),
      version: 1,
    }
  )
);

export const nativeToolPreferencesSelectors = {
  isToolEnabled: (store: NativeToolPreferencesStore): NativeToolPreferencesStore['isToolEnabled'] =>
    store.isToolEnabled,
  toolStates: (store: NativeToolPreferencesStore): NativeToolStateMap => store.toolStates,
};
