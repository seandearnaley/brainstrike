/**
 * Permission policy store (permission engine, step 2/4).
 *
 * Holds the user's tool-permission posture, keyed on the `ToolRiskCategory`
 * taxonomy from `@brainstrike/assistant-contract`:
 *
 * - `policies` — per-category decision (allow | ask | deny). PERSISTED.
 * - `yolo` — master "allow everything" toggle. PERSISTED.
 * - `perToolOverrides` — per-tool-id decision that beats the category policy.
 *   PERSISTED.
 * - `sessionGrants` — categories the user granted "always allow for this
 *   session". SESSION-LIVED, deliberately NOT persisted (like the assistant
 *   context-usage store), so reloading the app forgets every session grant by
 *   design. The `partialize` below excludes it from storage.
 *
 * This store owns STATE only. The pure decision resolver
 * (`resolvePermissionDecision`) lives in `@brainstrike/assistant-contract` so it
 * can be unit-tested without zustand and reused identically in web + Electron;
 * enforcement into the Mastra loop (PR-1.3) and the approval UI (PR-1.4) come
 * later and consume this store's snapshot.
 *
 * Factory reset: the persisted slice is wiped by `clearPersistentUiState`'s
 * blanket `localStorage.clear()` (see `factory-reset-helpers.ts`), and the live
 * store is reset explicitly via `resetPermissionPolicyStoreToDefaults`, which
 * `clearPersistentUiState` invokes so in-memory session grants and policy state
 * never survive a reset (FACTORY RESET CONTRACT).
 */

import {
  DEFAULT_PERMISSION_POLICIES,
  isPermissionDecision,
  type PermissionDecision,
  type PermissionPolicies,
  type PerToolPermissionOverrides,
  type ToolRiskCategory,
} from '@brainstrike/assistant-contract/tool-metadata';
import { createBrowserJsonStorage } from '@brainstrike/storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

interface PermissionPolicyData {
  /**
   * Master switch for permission enforcement. PERSISTED. Defaults to `true`
   * (enforce-on-by-default, the P1 security fix): with the default policy
   * (`{read:allow, mcp:allow, edit:ask, execute:ask}`) the assistant runs
   * read/MCP tools freely but PROMPTS for per-call approval before any mutation
   * (edit) or command (execute). When the user turns this OFF (their explicit
   * opt-out) the renderer sends NO permission snapshot to the assistant server,
   * the runtime gets no `permissionPolicy`, and the tool map is unchanged. Only
   * when `true` is the policy serialized + enforced.
   */
  enforce: boolean;
  /** Per-tool-id override that beats the category policy. PERSISTED. */
  perToolOverrides: PerToolPermissionOverrides;
  /** Per-category permission decision. PERSISTED. */
  policies: PermissionPolicies;
  /**
   * Categories granted "always allow for this session". SESSION-LIVED — NOT
   * persisted; excluded from `partialize`, lost on reload by design.
   */
  sessionGrants: Set<ToolRiskCategory>;
  /** Master "allow everything" toggle. PERSISTED. */
  yolo: boolean;
}

/**
 * Serializable input to the runtime permission gate, read from the store and
 * attached to the assistant request ONLY when `enforce` is true. `sessionGrants`
 * is an ARRAY here (the live store holds a `Set`) so the snapshot crosses the
 * runtime/IPC boundary as plain JSON, matching `PermissionToolGateSnapshot`.
 */
export interface PermissionToolGateSnapshotInput {
  /** Master OPT-IN switch — the caller sends the snapshot only when this is true. */
  enforce: boolean;
  perToolOverrides: PerToolPermissionOverrides;
  policies: PermissionPolicies;
  sessionGrants: ToolRiskCategory[];
  yolo: boolean;
}

interface PermissionPolicyActions {
  /** Clear every session grant (e.g. on a new session). */
  clearSessionGrants: () => void;
  /**
   * Grant ALL FOUR risk categories for this session in ONE atomic `set()`
   * (subscribers observe a single update, never a partial grant set). This is
   * the "Allow all tools this session" affordance: it is deliberately NOT a
   * session-yolo flag — per-tool DENY overrides still beat a blanket session
   * grant, and Settings lists/revokes each category individually.
   */
  grantAllSessionCategories: () => void;
  /** Grant "always allow for this session" for a category. */
  grantSessionCategory: (category: ToolRiskCategory) => void;
  /** Revoke a single session grant; the category falls back to its policy. */
  revokeSessionCategory: (category: ToolRiskCategory) => void;
  /** Set the decision for a single risk category. */
  setCategoryPolicy: (category: ToolRiskCategory, decision: PermissionDecision) => void;
  /** Toggle the master OPT-IN enforcement switch. */
  setEnforce: (enforce: boolean) => void;
  /**
   * Set or clear a per-tool override. Pass `null` to remove the override for
   * `toolId` and fall back to the category policy.
   */
  setToolOverride: (toolId: string, decision: PermissionDecision | null) => void;
  /** Toggle the master YOLO override. */
  setYolo: (yolo: boolean) => void;
}

export type PermissionPolicyStore = PermissionPolicyData & PermissionPolicyActions;

const STORE_NAME = 'permission-policy.v1' as const;
// v2: enforce-on-by-default (P1 security fix). The persistence KEY stays
// `permission-policy.v1` (renaming it would orphan every persisted slice and
// silently reset users); only the in-payload `version` field bumps so the
// migrate below can adopt the new secure default for slices that predate it.
const STORE_VERSION = 2 as const;

const ALL_RISK_CATEGORIES: readonly ToolRiskCategory[] = ['read', 'edit', 'execute', 'mcp'];

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
      electronAPI?: {
        storage?: ElectronStorageBridge;
      };
    }
  ).electronAPI?.storage;

  return bridge ?? null;
}

function createPermissionPolicyStorage() {
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

const storage = createJSONStorage(() => createPermissionPolicyStorage());

function defaultPolicies(): PermissionPolicies {
  return { ...DEFAULT_PERMISSION_POLICIES };
}

function defaultData(): PermissionPolicyData {
  return {
    // enforce-on-by-default (P1 fix): with the default policies below, read/mcp
    // run free and edit/execute PROMPT for per-call approval.
    enforce: true,
    perToolOverrides: {},
    policies: defaultPolicies(),
    sessionGrants: new Set<ToolRiskCategory>(),
    yolo: false,
  };
}

/**
 * Coerce an unknown persisted `policies` value into a complete, valid record.
 * Unknown categories are dropped; missing or malformed entries fall back to the
 * default for that category. (The resolver is strict at decision time; the
 * store self-heals persisted data so a malformed payload cannot wedge the UI.)
 */
function sanitizePolicies(value: unknown): PermissionPolicies {
  const result = defaultPolicies();
  if (!value || typeof value !== 'object') {
    return result;
  }
  const candidate = value as Record<string, unknown>;
  for (const category of ALL_RISK_CATEGORIES) {
    const entry = candidate[category];
    if (isPermissionDecision(entry)) {
      result[category] = entry;
    }
  }
  return result;
}

function sanitizeOverrides(value: unknown): PerToolPermissionOverrides {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const candidate = value as Record<string, unknown>;
  const result: PerToolPermissionOverrides = {};
  for (const [toolId, decision] of Object.entries(candidate)) {
    if (isPermissionDecision(decision)) {
      result[toolId] = decision;
    }
  }
  return result;
}

export const usePermissionPolicyStore = create<PermissionPolicyStore>()(
  persist(
    (set) => ({
      ...defaultData(),
      clearSessionGrants: () =>
        set((state) =>
          state.sessionGrants.size === 0 ? state : { sessionGrants: new Set<ToolRiskCategory>() }
        ),
      grantAllSessionCategories: () =>
        set((state) => {
          if (ALL_RISK_CATEGORIES.every((category) => state.sessionGrants.has(category))) {
            return state;
          }
          return { sessionGrants: new Set<ToolRiskCategory>(ALL_RISK_CATEGORIES) };
        }),
      grantSessionCategory: (category) =>
        set((state) => {
          if (state.sessionGrants.has(category)) {
            return state;
          }
          const next = new Set(state.sessionGrants);
          next.add(category);
          return { sessionGrants: next };
        }),
      revokeSessionCategory: (category) =>
        set((state) => {
          if (!state.sessionGrants.has(category)) {
            return state;
          }
          const next = new Set(state.sessionGrants);
          next.delete(category);
          return { sessionGrants: next };
        }),
      setCategoryPolicy: (category, decision) =>
        set((state) => ({
          policies: { ...state.policies, [category]: decision },
        })),
      setEnforce: (enforce) => set({ enforce }),
      setToolOverride: (toolId, decision) =>
        set((state) => {
          const next = { ...state.perToolOverrides };
          if (decision === null) {
            delete next[toolId];
          } else {
            next[toolId] = decision;
          }
          return { perToolOverrides: next };
        }),
      setYolo: (yolo) => set({ yolo }),
    }),
    {
      migrate: (persistedState, version) => {
        if (!(persistedState && typeof persistedState === 'object')) {
          return defaultData();
        }
        const candidate = persistedState as Partial<PermissionPolicyData>;
        return {
          // enforce-on-by-default (P1 SECURITY fix). Under v1, `enforce` defaulted
          // to `false` AND `partialize` always wrote it, so a persisted `false`
          // from a v1 slice is the OLD DEFAULT — indistinguishable from a
          // deliberate opt-out. For a security fix we adopt the secure default
          // (`true`) for ANY pre-v2 slice, accepting that a user who genuinely
          // opted out under v1 gets re-prompted once (the safe direction). Only a
          // v2+ persisted boolean is a real, post-default-on choice and is
          // honored verbatim. Skipping this lets upgrading `enforce:false` users
          // get the now-always-registered, ungated `executeCommand` — the exact
          // regression this PR exists to prevent.
          enforce:
            version >= STORE_VERSION && typeof candidate.enforce === 'boolean'
              ? candidate.enforce
              : true,
          perToolOverrides: sanitizeOverrides(candidate.perToolOverrides),
          policies: sanitizePolicies(candidate.policies),
          // Session grants are never persisted; always start empty after rehydration.
          sessionGrants: new Set<ToolRiskCategory>(),
          yolo: typeof candidate.yolo === 'boolean' ? candidate.yolo : false,
        } satisfies PermissionPolicyData;
      },
      name: STORE_NAME,
      // SESSION-ONLY `sessionGrants` is intentionally excluded — only the
      // persisted slice is written to storage.
      partialize: (state) => ({
        enforce: state.enforce,
        perToolOverrides: state.perToolOverrides,
        policies: state.policies,
        yolo: state.yolo,
      }),
      storage,
      version: STORE_VERSION,
    }
  )
);

/**
 * Resets the live store to defaults AND clears its persisted slice. Invoked by
 * the factory-reset pipeline so in-memory session grants and persisted policies
 * never survive a reset (FACTORY RESET CONTRACT).
 */
export function resetPermissionPolicyStoreToDefaults(): void {
  try {
    const persistApi = (
      usePermissionPolicyStore as typeof usePermissionPolicyStore & {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
  } catch {
    // Best effort: storage errors must not block the reset of in-memory state.
  }
  usePermissionPolicyStore.setState(defaultData());
}

export const permissionPolicySelectors = {
  enforce: (store: PermissionPolicyStore): boolean => store.enforce,
  perToolOverrides: (store: PermissionPolicyStore): PerToolPermissionOverrides =>
    store.perToolOverrides,
  policies: (store: PermissionPolicyStore): PermissionPolicies => store.policies,
  sessionGrants: (store: PermissionPolicyStore): ReadonlySet<ToolRiskCategory> =>
    store.sessionGrants,
  yolo: (store: PermissionPolicyStore): boolean => store.yolo,
};

/**
 * Build the SERIALIZABLE snapshot input for the runtime permission gate from a
 * store snapshot. `sessionGrants` is materialized into a plain array so the
 * result crosses the renderer → assistant-server → runtime boundary as JSON.
 *
 * The returned `enforce` flag is the caller's gate: the renderer attaches the
 * rest of the snapshot to the assistant request ONLY when `enforce` is true (so
 * `enforce:false` guarantees passthrough — the runtime receives no
 * `permissionPolicy` and the tool map is unchanged). The pure mapping lives here
 * so it can be unit-tested without zustand.
 */
export function buildPermissionToolGateSnapshotInput(
  store: PermissionPolicyData
): PermissionToolGateSnapshotInput {
  return {
    enforce: store.enforce,
    perToolOverrides: { ...store.perToolOverrides },
    policies: { ...store.policies },
    sessionGrants: Array.from(store.sessionGrants),
    yolo: store.yolo,
  };
}

/**
 * Read the current store state and build the serializable gate snapshot input.
 * Convenience for non-React callers (e.g. request assembly) that need a
 * point-in-time snapshot outside a React render.
 */
export function getPermissionToolGateSnapshotInput(): PermissionToolGateSnapshotInput {
  return buildPermissionToolGateSnapshotInput(usePermissionPolicyStore.getState());
}

/** Test-only reset helper. */
export function __resetPermissionPolicyStoreForTests(): void {
  resetPermissionPolicyStoreToDefaults();
}
