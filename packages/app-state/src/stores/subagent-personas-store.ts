/**
 * Subagent persona availability preferences (persisted).
 *
 * A master `delegationEnabled` switch plus per-persona disables (by persona
 * id, built-in or user-defined). The renderer attaches the availability
 * request to the assistant request ONLY when something diverges from the
 * defaults; the desktop assistant server applies it when resolving the
 * per-request persona set. A preference, not a security boundary: it can only
 * REDUCE the persona set.
 *
 * Presence-means-non-default: every writer omits the key via conditional
 * spread, so a key check and a value check agree for THIS field. Not every
 * opt-in request field works that way — see the wire-shape note on
 * `permissionPolicyRequest` in `packages/agent/src/types.ts` before copying
 * this pattern.
 *
 * Structure mirrors permission-policy-store.ts (create + persist + migrate +
 * partialize + factory-reset helper).
 */

import type { SubagentPersonasAvailabilityRequest } from '@brainstrike/assistant-contract';
import { createBrowserJsonStorage } from '@brainstrike/storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { createSanitizedPersistMerge } from './sanitized-persist-merge';

export interface SubagentPersonasData {
  delegationEnabled: boolean;
  disabledPersonaIds: readonly string[];
}

export interface SubagentPersonasActions {
  setDelegationEnabled: (enabled: boolean) => void;
  setPersonaEnabled: (personaId: string, enabled: boolean) => void;
}

export type SubagentPersonasStore = SubagentPersonasData & SubagentPersonasActions;

const STORE_NAME = 'subagent-personas.v1' as const;
const STORE_VERSION = 1 as const;

interface ElectronStorageBridge {
  readonly getItem: (key: string) => Promise<string | null>;
  readonly removeItem: (key: string) => Promise<void>;
  readonly setItem: (key: string, value: string) => Promise<void>;
}

function getElectronStorageBridge(): ElectronStorageBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (
    window as Window & {
      electronAPI?: { storage?: ElectronStorageBridge };
    }
  ).electronAPI?.storage;
  return bridge ?? null;
}

function createSubagentPersonasStorage() {
  const electronStorage = getElectronStorageBridge();
  if (electronStorage) {
    return {
      getItem: (key: string) => electronStorage.getItem(key),
      removeItem: (key: string) => electronStorage.removeItem(key),
      setItem: (key: string, value: string) => electronStorage.setItem(key, value),
    };
  }
  return createBrowserJsonStorage();
}

const storage = createJSONStorage(() => createSubagentPersonasStorage());

function defaultData(): SubagentPersonasData {
  return {
    delegationEnabled: true,
    disabledPersonaIds: [],
  };
}

function sanitizeDisabledIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function sanitizePersistedData(persistedState: unknown): SubagentPersonasData {
  const candidate =
    persistedState && typeof persistedState === 'object'
      ? (persistedState as Partial<SubagentPersonasData>)
      : {};
  return {
    delegationEnabled:
      typeof candidate.delegationEnabled === 'boolean' ? candidate.delegationEnabled : true,
    disabledPersonaIds: sanitizeDisabledIds(candidate.disabledPersonaIds),
  };
}

export const useSubagentPersonasStore = create<SubagentPersonasStore>()(
  persist(
    (set) => ({
      ...defaultData(),
      setDelegationEnabled: (enabled) => set({ delegationEnabled: enabled }),
      setPersonaEnabled: (personaId, enabled) =>
        set((state) => {
          const disabled = new Set(state.disabledPersonaIds);
          if (enabled) {
            if (!disabled.has(personaId)) {
              return state;
            }
            disabled.delete(personaId);
          } else {
            if (disabled.has(personaId)) {
              return state;
            }
            disabled.add(personaId);
          }
          return { disabledPersonaIds: Array.from(disabled) };
        }),
    }),
    {
      merge: createSanitizedPersistMerge<SubagentPersonasStore, SubagentPersonasData>(
        sanitizePersistedData
      ),
      migrate: sanitizePersistedData,
      name: STORE_NAME,
      partialize: (state) => ({
        delegationEnabled: state.delegationEnabled,
        disabledPersonaIds: state.disabledPersonaIds,
      }),
      storage,
      version: STORE_VERSION,
    }
  )
);

/**
 * Resets the live store to defaults AND clears its persisted slice (FACTORY
 * RESET CONTRACT — invoked from factory-reset-helpers.clearBrowserStorage).
 */
export function resetSubagentPersonasStoreToDefaults(): void {
  try {
    const persistApi = (
      useSubagentPersonasStore as typeof useSubagentPersonasStore & {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
  } catch {
    // Best effort: storage errors must not block the reset of in-memory state.
  }
  useSubagentPersonasStore.setState(defaultData());
}

export const subagentPersonasSelectors = {
  delegationEnabled: (store: SubagentPersonasStore): boolean => store.delegationEnabled,
  disabledPersonaIds: (store: SubagentPersonasStore): readonly string[] => store.disabledPersonaIds,
};

/**
 * Build the wire request from a store snapshot. Returns `undefined` at the
 * defaults so the field stays OFF the wire (presence-means-non-default); the
 * pure mapping lives here so it is unit-testable without zustand.
 */
export function buildSubagentPersonasAvailabilityRequest(
  store: SubagentPersonasData
): SubagentPersonasAvailabilityRequest | undefined {
  const divergent: {
    delegationEnabled?: boolean;
    disabledPersonaIds?: readonly string[];
  } = {};
  if (!store.delegationEnabled) {
    divergent.delegationEnabled = false;
  }
  if (store.disabledPersonaIds.length > 0) {
    divergent.disabledPersonaIds = [...store.disabledPersonaIds];
  }
  return Object.keys(divergent).length > 0 ? divergent : undefined;
}

/** Non-React convenience: snapshot the live store into the wire request. */
export function getSubagentPersonasAvailabilityRequest():
  | SubagentPersonasAvailabilityRequest
  | undefined {
  return buildSubagentPersonasAvailabilityRequest(useSubagentPersonasStore.getState());
}

/** Test-only reset helper. */
export function __resetSubagentPersonasStoreForTests(): void {
  resetSubagentPersonasStoreToDefaults();
}
