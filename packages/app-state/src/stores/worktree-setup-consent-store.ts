/**
 * Durable per-repository consent for repository-committed worktree setup scripts.
 *
 * Pinned to the script's SHA-256 at decision time (mirrors `hook-trust-store.ts`):
 * the renderer only ATTESTS a decision over the wire; the desktop server
 * independently re-hashes disk and runs the script only when the disk hash
 * matches the decision's hash. A script that changed since the decision
 * (pull / branch switch / rebase) therefore re-prompts instead of running (or
 * staying skipped) under a stale grant.
 *
 * Both approval and denial persist locally, and either can be revoked
 * explicitly (`revoke`) — a decision is not permanent short of that or a
 * factory reset, which clears every decision.
 */

import { createBrowserJsonStorage } from '@brainstrike/storage';
import type { WorktreeRepositorySetupDecision } from '@brainstrike/types';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { createSanitizedPersistMerge } from './sanitized-persist-merge';

export interface WorktreeSetupConsentRecord {
  readonly decidedAt: number;
  readonly decision: WorktreeRepositorySetupDecision;
  readonly scriptSha256: string;
}

type DecisionsByRepositoryId = Record<string, WorktreeSetupConsentRecord>;

interface WorktreeSetupConsentData {
  decisionsByRepositoryId: DecisionsByRepositoryId;
}

interface WorktreeSetupConsentActions {
  /** Record (or replace) a repository's decision, pinned to the script's current hash. */
  decide: (
    repositoryId: string,
    decision: WorktreeRepositorySetupDecision,
    scriptSha256: string
  ) => void;
  /** Clear a repository's decision — the next create re-prompts for it. */
  revoke: (repositoryId: string) => void;
}

export type WorktreeSetupConsentStore = WorktreeSetupConsentData & WorktreeSetupConsentActions;

const STORE_NAME = 'worktree-setup-consent.v1' as const;
// No version bump for the decision-shape change (bare string → { decision,
// scriptSha256, decidedAt }): `sanitizeDecisions` below already rejects any
// entry that doesn't match the current shape regardless of the stored
// `version`, which is the same fail-closed effect a migrate() would give —
// an old bare-string row (or any row missing a hash) is dropped, so that
// repository re-prompts on its next create. Simpler than a version bump
// because the ONLY consumer of persisted data is this sanitizer.
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

/**
 * Coerce an unknown persisted decisions map into valid records. An entry that
 * is not a well-formed `{ decision, scriptSha256, decidedAt }` — including
 * the pre-hash bare-string shape — is dropped (self-heal, fail closed): that
 * repository simply re-prompts on its next create rather than the store
 * crashing or silently trusting a hashless grant.
 */
function sanitizeDecisions(value: unknown): DecisionsByRepositoryId {
  if (!(value && typeof value === 'object')) {
    return {};
  }
  const decisions: DecisionsByRepositoryId = {};
  for (const [repositoryId, record] of Object.entries(value)) {
    if (repositoryId.length === 0 || !record || typeof record !== 'object') {
      continue;
    }
    const { decision, scriptSha256, decidedAt } = record as Record<string, unknown>;
    if (
      (decision === 'approved' || decision === 'denied') &&
      typeof scriptSha256 === 'string' &&
      scriptSha256.length > 0 &&
      typeof decidedAt === 'number'
    ) {
      decisions[repositoryId] = { decidedAt, decision, scriptSha256 };
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
      decide: (repositoryId, decision, scriptSha256) => {
        if (repositoryId.length === 0) {
          throw new Error('Worktree setup consent requires a repository id.');
        }
        if (scriptSha256.length === 0) {
          throw new Error('Worktree setup consent requires the script hash it is pinned to.');
        }
        set((state) => ({
          decisionsByRepositoryId: {
            ...state.decisionsByRepositoryId,
            [repositoryId]: { decidedAt: Date.now(), decision, scriptSha256 },
          },
        }));
      },
      revoke: (repositoryId) =>
        set((state) => {
          if (!(repositoryId in state.decisionsByRepositoryId)) {
            return state;
          }
          const next = { ...state.decisionsByRepositoryId };
          delete next[repositoryId];
          return { decisionsByRepositoryId: next };
        }),
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

export const worktreeSetupConsentSelectors = {
  decisionsByRepositoryId: (store: WorktreeSetupConsentStore): DecisionsByRepositoryId =>
    store.decisionsByRepositoryId,
};

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
