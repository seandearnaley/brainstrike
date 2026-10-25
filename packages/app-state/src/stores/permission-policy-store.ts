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
 *   design. Saves write only the persisted slice.
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
import type { StateStorage } from 'zustand/middleware';
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
  /**
   * Set the decision for a single risk category. Like every saved setting, it
   * changes once storage commits it; the returned promise settles then, or on
   * failure, which `usePermissionPolicySave` reports.
   */
  setCategoryPolicy: (category: ToolRiskCategory, decision: PermissionDecision) => Promise<void>;
  /** Toggle the master OPT-IN enforcement switch (saved). */
  setEnforce: (enforce: boolean) => Promise<void>;
  /**
   * Set or clear a per-tool override. Pass `null` to remove the override for
   * `toolId` and fall back to the category policy.
   */
  setToolOverride: (toolId: string, decision: PermissionDecision | null) => Promise<void>;
  /** Toggle the master YOLO override (saved). */
  setYolo: (yolo: boolean) => Promise<void>;
}

export type PermissionPolicyStore = PermissionPolicyData & PermissionPolicyActions;
type PersistedPermissionPolicyData = Pick<
  PermissionPolicyData,
  'enforce' | 'perToolOverrides' | 'policies' | 'yolo'
>;

const STORE_NAME = 'permission-policy.v1' as const;
// v2: enforce-on-by-default (P1 security fix). The persistence KEY stays
// `permission-policy.v1` (renaming it would orphan every persisted slice and
// silently reset users); only the in-payload `version` field bumps so the
// migrate below can adopt the new secure default for slices that predate it.
const STORE_VERSION = 2 as const;
/** The persisted envelope's version, which a host-backed persistence writes back. */
export const PERMISSION_POLICY_STORE_VERSION = STORE_VERSION;

const ALL_RISK_CATEGORIES: readonly ToolRiskCategory[] = ['read', 'edit', 'execute', 'mcp'];

/**
 * Where a client whose agent host owns the saved policy keeps it (the desktop:
 * the host's StateStore, BST-1930 stage e). That client provides it when it
 * starts; until then the store reads and writes nothing, and nothing goes to
 * this window's own storage.
 */
const hostPersistence = Promise.withResolvers<StateStorage>();

/** The desktop renderer's host-backed persistence for the saved policy. */
export function provideHostPermissionPolicyPersistence(storage: StateStorage): void {
  hostPersistence.resolve(storage);
}

/** Capability, not platform: a window with an agent host client keeps the policy there. */
function hasAgentHostClient(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window as Window & { agentHost?: unknown }).agentHost !== undefined
  );
}

function createPermissionPolicyStorage(): StateStorage | Promise<StateStorage> {
  return hasAgentHostClient() ? hostPersistence.promise : createBrowserJsonStorage();
}

function createDeferredPermissionPolicyStorage(): StateStorage {
  let lazyStorage: StateStorage | undefined;
  let lazyStoragePromise: Promise<StateStorage> | undefined;
  const resolveStorage = (): Promise<StateStorage> => {
    lazyStoragePromise ??= Promise.resolve()
      .then(createPermissionPolicyStorage)
      .then((resolvedStorage) => {
        lazyStorage = resolvedStorage;
        return resolvedStorage;
      })
      .catch((error: unknown) => {
        lazyStoragePromise = undefined;
        throw error;
      });
    return lazyStoragePromise;
  };

  return {
    getItem: (key: string) => {
      if (lazyStorage) {
        return lazyStorage.getItem(key);
      }
      return resolveStorage().then((resolved) => resolved.getItem(key));
    },
    removeItem: (key: string) => {
      if (lazyStorage) {
        return lazyStorage.removeItem(key);
      }
      return resolveStorage().then((resolved) => resolved.removeItem(key));
    },
    setItem: (key: string, value: string) => {
      if (lazyStorage) {
        return lazyStorage.setItem(key, value);
      }
      return resolveStorage().then((resolved) => resolved.setItem(key, value));
    },
  };
}

const storage = createDeferredPermissionPolicyStorage();

/** The saved envelope ({ state, version }); a slice without a version predates versioning. */
function readSavedEnvelope(raw: string): { state: unknown; version: number } {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    return { state: undefined, version: 0 };
  }
  return {
    state: 'state' in parsed ? parsed.state : undefined,
    version: 'version' in parsed && typeof parsed.version === 'number' ? parsed.version : 0,
  };
}

type PermissionPolicyHydration =
  | { status: 'loading' | 'ready' }
  | { status: 'failed'; error: string };

/** Transient read status; only the policy store persists data. */
export const usePermissionPolicyHydration = create<PermissionPolicyHydration>(() => ({
  status: 'loading',
}));

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

function sanitizePersistedData(persistedState: unknown): PersistedPermissionPolicyData {
  const candidate =
    persistedState && typeof persistedState === 'object'
      ? (persistedState as Partial<PermissionPolicyData>)
      : {};
  return {
    enforce: typeof candidate.enforce === 'boolean' ? candidate.enforce : true,
    perToolOverrides: sanitizeOverrides(candidate.perToolOverrides),
    policies: sanitizePolicies(candidate.policies),
    yolo: typeof candidate.yolo === 'boolean' ? candidate.yolo : false,
  };
}

/**
 * Rebuilds the saved slice from storage at any version. Exported for its tests.
 *
 * enforce-on-by-default (P1 SECURITY fix). Under v1, `enforce` defaulted to
 * `false` AND `partialize` always wrote it, so a persisted `false` from a v1
 * slice is the OLD DEFAULT — indistinguishable from a deliberate opt-out. For a
 * security fix we adopt the secure default (`true`) for ANY pre-v2 slice,
 * accepting that a user who genuinely opted out under v1 gets re-prompted once
 * (the safe direction). Only a v2+ persisted boolean is a real, post-default-on
 * choice and is honored verbatim. Skipping this lets upgrading `enforce:false`
 * users get the now-always-registered, ungated `executeCommand` — the exact
 * regression this store exists to prevent.
 */
export function restorePersistedPermissionPolicy(
  persistedState: unknown,
  version: number
): PersistedPermissionPolicyData {
  const sanitized = sanitizePersistedData(persistedState);
  return { ...sanitized, enforce: version >= STORE_VERSION ? sanitized.enforce : true };
}

function persistedSlice(state: PermissionPolicyData): PersistedPermissionPolicyData {
  return {
    enforce: state.enforce,
    perToolOverrides: state.perToolOverrides,
    policies: state.policies,
    yolo: state.yolo,
  };
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The latest save's outcome; a failed save leaves the store on the last saved value. */
export const usePermissionPolicySave = create<{ error: string | null }>(() => ({ error: null }));

/**
 * The store shows a saved choice only once storage has committed it, so what
 * the user sees is what a restart or a kill finds (ADR-0031). Saves wait for
 * hydration and run one at a time, each from the last saved slice. Session
 * grants are never saved and change at once.
 */
let hydrated: Promise<void> = Promise.resolve();
let latestSave: Promise<void> = Promise.resolve();

export const usePermissionPolicyStore = create<PermissionPolicyStore>()((set, get) => {
  const save = (
    change: (saved: PersistedPermissionPolicyData) => PersistedPermissionPolicyData
  ): Promise<void> => {
    latestSave = latestSave.then(async () => {
      try {
        // A policy that failed to load is never overwritten from defaults.
        await hydrated;
        const next = change(persistedSlice(get()));
        await storage.setItem(STORE_NAME, JSON.stringify({ state: next, version: STORE_VERSION }));
        set(next);
        usePermissionPolicySave.setState({ error: null });
      } catch (error) {
        usePermissionPolicySave.setState({ error: failureMessage(error) });
      }
    });
    return latestSave;
  };
  return {
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
      save((saved) => ({ ...saved, policies: { ...saved.policies, [category]: decision } })),
    setEnforce: (enforce) => save((saved) => ({ ...saved, enforce })),
    setToolOverride: (toolId, decision) =>
      save((saved) => {
        const perToolOverrides = { ...saved.perToolOverrides };
        if (decision === null) {
          delete perToolOverrides[toolId];
        } else {
          perToolOverrides[toolId] = decision;
        }
        return { ...saved, perToolOverrides };
      }),
    setYolo: (yolo) => save((saved) => ({ ...saved, yolo })),
  };
});

/**
 * Loads the saved policy into the store; Settings retries with it after a
 * failed load. Saves made meanwhile wait for it.
 */
export function rehydratePermissionPolicy(): Promise<void> {
  const load = (async () => {
    usePermissionPolicyHydration.setState({ status: 'loading' }, true);
    try {
      const raw = await storage.getItem(STORE_NAME);
      if (raw !== null) {
        const saved = readSavedEnvelope(raw);
        usePermissionPolicyStore.setState(
          restorePersistedPermissionPolicy(saved.state, saved.version)
        );
      }
      usePermissionPolicyHydration.setState({ status: 'ready' }, true);
    } catch (error) {
      usePermissionPolicyHydration.setState(
        { error: failureMessage(error), status: 'failed' },
        true
      );
      throw error;
    }
  })();
  hydrated = load;
  return load.catch(() => undefined);
}

void rehydratePermissionPolicy();

/**
 * Resets the live store to defaults AND clears its persisted slice. Invoked by
 * the factory-reset pipeline so in-memory session grants and persisted policies
 * never survive a reset (FACTORY RESET CONTRACT).
 */
export function resetPermissionPolicyStoreToDefaults(): void {
  Promise.resolve()
    .then(() => storage.removeItem(STORE_NAME))
    .catch(() => {
      // Best effort: storage errors must not block the reset of in-memory state.
    });
  usePermissionPolicyStore.setState(defaultData());
  usePermissionPolicySave.setState({ error: null });
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
