/**
 * Hook-trust store (tool-lifecycle hooks security spine).
 *
 * Records the user's per-root approval of a project `.brainstrike/hooks.json`,
 * pinned to the file's SHA-256 at approval time. PERSISTED and
 * factory-reset-registered. Mirrors `permission-policy-store` in shape.
 *
 * The renderer only ATTESTS these approvals over the wire (`HookTrustRequest`);
 * the desktop server independently re-hashes disk and runs a root's hooks only
 * when the disk hash matches the approved hash for that `rootId`. Keyed by
 * durable `rootId`, never raw path (multi-root discipline).
 */

import type { HookTrustApproval, HookTrustRequest } from '@brainstrike/assistant-contract';
import { createBrowserJsonStorage } from '@brainstrike/storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

interface HookTrustApprovalRecord {
  readonly approvedAt: number;
  readonly sha256: string;
}

type ApprovalsByRootId = Record<string, HookTrustApprovalRecord>;

interface HookTrustData {
  /** rootId → approved content hash + timestamp. PERSISTED. */
  approvalsByRootId: ApprovalsByRootId;
}

interface HookTrustActions {
  /** Approve a project root's current hooks.json content hash. */
  approveRoot: (rootId: string, sha256: string) => void;
  /** Revoke a root's approval (a changed file also loses trust server-side). */
  revokeRoot: (rootId: string) => void;
}

export type HookTrustStore = HookTrustData & HookTrustActions;

const STORE_NAME = 'hook-trust.v1' as const;
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
  const bridge = (window as Window & { electronAPI?: { storage?: ElectronStorageBridge } })
    .electronAPI?.storage;
  return bridge ?? null;
}

function createHookTrustStorage() {
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

const storage = createJSONStorage(() => createHookTrustStorage());

function defaultData(): HookTrustData {
  return { approvalsByRootId: {} };
}

/**
 * Coerce an unknown persisted approvals map into a valid record. A malformed
 * entry is dropped (self-heal); a corrupt payload cannot wedge the UI.
 */
function sanitizeApprovals(value: unknown): ApprovalsByRootId {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const candidate = value as Record<string, unknown>;
  const result: ApprovalsByRootId = {};
  for (const [rootId, record] of Object.entries(candidate)) {
    if (!record || typeof record !== 'object') {
      continue;
    }
    const { sha256, approvedAt } = record as Record<string, unknown>;
    if (typeof sha256 === 'string' && sha256.length > 0 && typeof approvedAt === 'number') {
      result[rootId] = { approvedAt, sha256 };
    }
  }
  return result;
}

export const useHookTrustStore = create<HookTrustStore>()(
  persist(
    (set) => ({
      ...defaultData(),
      approveRoot: (rootId, sha256) =>
        set((state) => ({
          approvalsByRootId: {
            ...state.approvalsByRootId,
            [rootId]: { approvedAt: Date.now(), sha256 },
          },
        })),
      revokeRoot: (rootId) =>
        set((state) => {
          if (!(rootId in state.approvalsByRootId)) {
            return state;
          }
          const next = { ...state.approvalsByRootId };
          delete next[rootId];
          return { approvalsByRootId: next };
        }),
    }),
    {
      migrate: (persistedState) => {
        if (!(persistedState && typeof persistedState === 'object')) {
          return defaultData();
        }
        const candidate = persistedState as Partial<HookTrustData>;
        return {
          approvalsByRootId: sanitizeApprovals(candidate.approvalsByRootId),
        } satisfies HookTrustData;
      },
      name: STORE_NAME,
      partialize: (state) => ({ approvalsByRootId: state.approvalsByRootId }),
      storage,
      version: STORE_VERSION,
    }
  )
);

/**
 * Resets the live store to defaults AND clears its persisted slice. Invoked by
 * the factory-reset pipeline so approved trust never survives a reset.
 */
export function resetHookTrustStoreToDefaults(): void {
  try {
    const persistApi = (
      useHookTrustStore as typeof useHookTrustStore & {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
  } catch {
    // Best effort: storage errors must not block the reset of in-memory state.
  }
  useHookTrustStore.setState(defaultData());
}

export const hookTrustSelectors = {
  approvalsByRootId: (store: HookTrustStore): ApprovalsByRootId => store.approvalsByRootId,
};

/**
 * Build the SERIALIZABLE wire snapshot from a store snapshot. The pure mapping
 * lives here so it can be unit-tested without zustand.
 */
export function buildHookTrustRequest(store: HookTrustData): HookTrustRequest {
  const approvals: HookTrustApproval[] = Object.entries(store.approvalsByRootId).map(
    ([rootId, record]) => ({ approvedAt: record.approvedAt, rootId, sha256: record.sha256 })
  );
  return { approvals };
}

/** Read the current store state and build the serializable wire snapshot. */
export function getHookTrustRequest(): HookTrustRequest {
  return buildHookTrustRequest(useHookTrustStore.getState());
}

/** Test-only reset helper. */
export function __resetHookTrustStoreForTests(): void {
  resetHookTrustStoreToDefaults();
}
