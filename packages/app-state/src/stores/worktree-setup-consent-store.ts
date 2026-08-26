/**
 * Durable per-repository consent for repository-committed worktree setup scripts.
 * Both approval and denial persist locally; factory reset clears every decision.
 */

import { createBrowserJsonStorage } from '@brainstrike/storage';
import type { WorktreeRepositorySetupDecision } from '@brainstrike/types';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { createSanitizedPersistMerge } from './sanitized-persist-merge';

type DecisionsByRepositoryId = Record<string, WorktreeRepositorySetupDecision>;

interface WorktreeSetupConsentData {
  decisionsByRepositoryId: DecisionsByRepositoryId;
}

interface WorktreeSetupConsentActions {
  decide: (repositoryId: string, decision: WorktreeRepositorySetupDecision) => void;
}

export type WorktreeSetupConsentStore = WorktreeSetupConsentData & WorktreeSetupConsentActions;

const STORE_NAME = 'worktree-setup-consent.v1' as const;
const STORE_VERSION = 1 as const;

interface ElectronStorageBridge {
  readonly getItem: (key: string) => Promise<string | null>;
  readonly removeItem: (key: string) => Promise<void>;
  readonly setItem: (key: string, value: string) => Promise<void>;
}

function createConsentStorage(): StateStorage {
  if (typeof window !== 'undefined') {
    const bridge = (window as Window & { electronAPI?: { storage?: ElectronStorageBridge } })
      .electronAPI?.storage;
    if (bridge) {
      return bridge;
    }
  }
  return createBrowserJsonStorage();
}

function createDeferredConsentStorage(): StateStorage {
  let resolved: StateStorage | undefined;
  const getStorage = (): StateStorage => {
    resolved ??= createConsentStorage();
    return resolved;
  };
  return {
    getItem: (key) => getStorage().getItem(key),
    removeItem: (key) => getStorage().removeItem(key),
    setItem: (key, value) => getStorage().setItem(key, value),
  };
}

function defaultData(): WorktreeSetupConsentData {
  return { decisionsByRepositoryId: {} };
}

function sanitizeDecisions(value: unknown): DecisionsByRepositoryId {
  if (!(value && typeof value === 'object')) {
    return {};
  }
  const decisions: DecisionsByRepositoryId = {};
  for (const [repositoryId, decision] of Object.entries(value)) {
    if (repositoryId.length > 0 && (decision === 'approved' || decision === 'denied')) {
      decisions[repositoryId] = decision;
    }
  }
  return decisions;
}

function sanitizePersistedData(persistedState: unknown): WorktreeSetupConsentData {
  const candidate =
    persistedState && typeof persistedState === 'object'
      ? (persistedState as Partial<WorktreeSetupConsentData>)
      : {};
  return {
    decisionsByRepositoryId: sanitizeDecisions(candidate.decisionsByRepositoryId),
  };
}

const storage = createJSONStorage(createDeferredConsentStorage);

export const useWorktreeSetupConsentStore = create<WorktreeSetupConsentStore>()(
  persist(
    (set) => ({
      ...defaultData(),
      decide: (repositoryId, decision) => {
        if (repositoryId.length === 0) {
          throw new Error('Worktree setup consent requires a repository id.');
        }
        set((state) => ({
          decisionsByRepositoryId: {
            ...state.decisionsByRepositoryId,
            [repositoryId]: decision,
          },
        }));
      },
    }),
    {
      merge: createSanitizedPersistMerge<WorktreeSetupConsentStore, WorktreeSetupConsentData>(
        sanitizePersistedData
      ),
      migrate: (persistedState) => sanitizePersistedData(persistedState),
      name: STORE_NAME,
      partialize: (state) => ({
        decisionsByRepositoryId: state.decisionsByRepositoryId,
      }),
      storage,
      version: STORE_VERSION,
    }
  )
);

export async function ensureWorktreeSetupConsentHydrated(): Promise<void> {
  const persistApi = useWorktreeSetupConsentStore.persist;
  if (!persistApi.hasHydrated()) {
    await persistApi.rehydrate();
  }
  if (!persistApi.hasHydrated()) {
    throw new Error('Worktree setup consent store failed to hydrate.');
  }
}

export function resetWorktreeSetupConsentStoreToDefaults(): void {
  try {
    void useWorktreeSetupConsentStore.persist.clearStorage();
  } catch {
    // The factory reset's blanket storage clear remains authoritative; reset the
    // live state even when this best-effort targeted removal fails.
  }
  useWorktreeSetupConsentStore.setState(defaultData());
}

export function __resetWorktreeSetupConsentStoreForTests(): void {
  resetWorktreeSetupConsentStoreToDefaults();
}
