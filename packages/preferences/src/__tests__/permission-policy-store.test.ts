import { resolvePermissionDecision } from '@brainstrike/assistant-contract/tool-metadata';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetPermissionPolicyStoreForTests,
  buildPermissionToolGateSnapshotInput,
  getPermissionToolGateSnapshotInput,
  usePermissionPolicyStore,
} from '../stores/permission-policy-store';
import type { PersistApi } from './persist-api-test-helper';

const storeWithPersist = usePermissionPolicyStore as PersistApi<typeof usePermissionPolicyStore>;

const STORE_KEY = 'permission-policy.v1';

function readPersistedState(): {
  enforce?: unknown;
  policies?: unknown;
  yolo?: unknown;
  perToolOverrides?: unknown;
} {
  const raw = window.localStorage.getItem(STORE_KEY);
  if (raw === null) {
    throw new Error('expected persisted state in localStorage');
  }
  const parsed = JSON.parse(raw) as { state?: Record<string, unknown> };
  return parsed.state ?? {};
}

describe('permission-policy-store', () => {
  beforeEach(() => {
    __resetPermissionPolicyStoreForTests();
  });

  it('defaults to enforce ON, read:allow, edit/execute:ask, mcp:allow, yolo off, no grants or overrides', () => {
    const state = usePermissionPolicyStore.getState();
    // enforce-on-by-default (P1 fix): read/mcp run free; edit/execute prompt.
    expect(state.enforce).toBe(true);
    expect(state.policies).toEqual({ read: 'allow', edit: 'ask', execute: 'ask', mcp: 'allow' });
    expect(state.yolo).toBe(false);
    expect(state.sessionGrants.size).toBe(0);
    expect(state.perToolOverrides).toEqual({});
  });

  it('setEnforce toggles the enforcement switch (users can opt out)', () => {
    expect(usePermissionPolicyStore.getState().enforce).toBe(true);
    usePermissionPolicyStore.getState().setEnforce(false);
    expect(usePermissionPolicyStore.getState().enforce).toBe(false);
    usePermissionPolicyStore.getState().setEnforce(true);
    expect(usePermissionPolicyStore.getState().enforce).toBe(true);
  });

  it('setCategoryPolicy updates one category only', () => {
    usePermissionPolicyStore.getState().setCategoryPolicy('execute', 'deny');
    const { policies } = usePermissionPolicyStore.getState();
    expect(policies.execute).toBe('deny');
    expect(policies.read).toBe('allow');
  });

  it('setYolo toggles the master override', () => {
    usePermissionPolicyStore.getState().setYolo(true);
    expect(usePermissionPolicyStore.getState().yolo).toBe(true);
  });

  it('grantSessionCategory promotes a category and feeds the resolver to allow', () => {
    usePermissionPolicyStore.getState().grantSessionCategory('edit');
    const state = usePermissionPolicyStore.getState();
    expect(state.sessionGrants.has('edit')).toBe(true);
    expect(
      resolvePermissionDecision({
        riskCategory: 'edit',
        policies: state.policies,
        yolo: state.yolo,
        sessionGrants: state.sessionGrants,
      })
    ).toBe('allow');
  });

  it('grantSessionCategory is idempotent (same set identity guard)', () => {
    const store = usePermissionPolicyStore.getState();
    store.grantSessionCategory('mcp');
    const first = usePermissionPolicyStore.getState().sessionGrants;
    usePermissionPolicyStore.getState().grantSessionCategory('mcp');
    expect(usePermissionPolicyStore.getState().sessionGrants).toBe(first);
  });

  it('clearSessionGrants empties the session grant set', () => {
    usePermissionPolicyStore.getState().grantSessionCategory('edit');
    usePermissionPolicyStore.getState().grantSessionCategory('mcp');
    usePermissionPolicyStore.getState().clearSessionGrants();
    expect(usePermissionPolicyStore.getState().sessionGrants.size).toBe(0);
  });

  it('setToolOverride sets and clears a per-tool override', () => {
    usePermissionPolicyStore.getState().setToolOverride('brainstrike.tool', 'deny');
    expect(usePermissionPolicyStore.getState().perToolOverrides['brainstrike.tool']).toBe('deny');

    usePermissionPolicyStore.getState().setToolOverride('brainstrike.tool', null);
    expect(
      usePermissionPolicyStore.getState().perToolOverrides['brainstrike.tool']
    ).toBeUndefined();
  });

  it('does NOT persist sessionGrants (session-lived; excluded from partialize)', () => {
    usePermissionPolicyStore.getState().grantSessionCategory('edit');
    usePermissionPolicyStore.getState().setCategoryPolicy('execute', 'deny');

    const state = readPersistedState();
    // Persisted slice carries policies but never sessionGrants.
    expect(state.policies).toBeDefined();
    expect('sessionGrants' in state).toBe(false);
  });

  it('persists enforce, policies, yolo, and perToolOverrides', () => {
    usePermissionPolicyStore.getState().setEnforce(true);
    usePermissionPolicyStore.getState().setYolo(true);
    usePermissionPolicyStore.getState().setToolOverride('brainstrike.tool', 'allow');

    const state = readPersistedState();
    expect(state.enforce).toBe(true);
    expect(state.yolo).toBe(true);
    expect(state.perToolOverrides).toEqual({ 'brainstrike.tool': 'allow' });
  });

  it('migrate self-heals malformed persisted policies and drops unknown categories', () => {
    const options = storeWithPersist.persist?.getOptions?.();
    if (!options?.migrate) {
      throw new Error('persist migrate unavailable for test');
    }

    const migrated = options.migrate(
      {
        policies: { read: 'allow', edit: 'prompt', bogus: 'allow' },
        yolo: 'yes',
        perToolOverrides: { 'brainstrike.ok': 'deny', 'brainstrike.bad': 'maybe' },
      },
      0
    ) as {
      enforce: boolean;
      policies: Record<string, string>;
      yolo: boolean;
      perToolOverrides: Record<string, string>;
      sessionGrants: Set<string>;
    };

    // edit:'prompt' is invalid -> default 'ask'; bogus dropped; mcp/execute defaulted.
    expect(migrated.policies).toEqual({ read: 'allow', edit: 'ask', execute: 'ask', mcp: 'allow' });
    // enforce absent from the legacy slice -> adopts the new secure default (ON).
    expect(migrated.enforce).toBe(true);
    // yolo:'yes' is not a boolean -> false.
    expect(migrated.yolo).toBe(false);
    // invalid override dropped, valid kept.
    expect(migrated.perToolOverrides).toEqual({ 'brainstrike.ok': 'deny' });
    // sessionGrants always start empty after rehydration.
    expect(migrated.sessionGrants.size).toBe(0);
  });

  it('reset clears both in-memory state and persisted storage', () => {
    usePermissionPolicyStore.getState().setEnforce(false);
    usePermissionPolicyStore.getState().setYolo(true);
    usePermissionPolicyStore.getState().grantSessionCategory('edit');
    expect(window.localStorage.getItem(STORE_KEY)).not.toBeNull();

    __resetPermissionPolicyStoreForTests();

    const state = usePermissionPolicyStore.getState();
    // Reset re-applies defaultData() → enforce ON (the secure default).
    expect(state.enforce).toBe(true);
    expect(state.yolo).toBe(false);
    expect(state.sessionGrants.size).toBe(0);
    expect(state.policies).toEqual({ read: 'allow', edit: 'ask', execute: 'ask', mcp: 'allow' });
    // clearStorage() wipes the prior slice; the subsequent default setState
    // re-persists the DEFAULT posture (not the customized one).
    const persisted = readPersistedState();
    expect(persisted.enforce).toBe(true);
    expect(persisted.yolo).toBe(false);
    expect(persisted.policies).toEqual({
      read: 'allow',
      edit: 'ask',
      execute: 'ask',
      mcp: 'allow',
    });
    expect(persisted.perToolOverrides).toEqual({});
  });

  it('migrate adopts the secure default (enforce:true) for a PRE-V2 enforce:false slice', () => {
    const options = storeWithPersist.persist?.getOptions?.();
    if (!options?.migrate) {
      throw new Error('persist migrate unavailable for test');
    }
    // Under v1, `false` was the OLD DEFAULT (always written), indistinguishable
    // from an opt-out — a security fix adopts the secure default for pre-v2.
    const migrated = options.migrate(
      { enforce: false, policies: { read: 'allow', edit: 'ask', execute: 'ask', mcp: 'allow' } },
      1
    ) as { enforce: boolean };
    expect(migrated.enforce).toBe(true);
  });

  it('migrate preserves an explicit V2+ persisted enforce:false (post-default-on opt-out)', () => {
    const options = storeWithPersist.persist?.getOptions?.();
    if (!options?.migrate) {
      throw new Error('persist migrate unavailable for test');
    }
    // A v2 slice with enforce:false is a real opt-out made AFTER enforce went on
    // by default, so it is honored verbatim.
    const migrated = options.migrate(
      { enforce: false, policies: { read: 'allow', edit: 'ask', execute: 'ask', mcp: 'allow' } },
      2
    ) as { enforce: boolean };
    expect(migrated.enforce).toBe(false);
  });
});

describe('buildPermissionToolGateSnapshotInput / getPermissionToolGateSnapshotInput', () => {
  beforeEach(() => {
    __resetPermissionPolicyStoreForTests();
  });

  it('produces the serializable gate-input shape from store state (sessionGrants as array)', () => {
    usePermissionPolicyStore.getState().setEnforce(true);
    usePermissionPolicyStore.getState().setCategoryPolicy('edit', 'deny');
    usePermissionPolicyStore.getState().setToolOverride('brainstrike.tool', 'allow');
    usePermissionPolicyStore.getState().grantSessionCategory('execute');

    const input = getPermissionToolGateSnapshotInput();

    expect(input.enforce).toBe(true);
    expect(input.policies).toEqual({
      read: 'allow',
      edit: 'deny',
      execute: 'ask',
      mcp: 'allow',
    });
    expect(input.yolo).toBe(false);
    // Set -> serializable array.
    expect(Array.isArray(input.sessionGrants)).toBe(true);
    expect(input.sessionGrants).toEqual(['execute']);
    expect(input.perToolOverrides).toEqual({ 'brainstrike.tool': 'allow' });
  });

  it('defaults to enforce:true with empty grants (the enforce-on-by-default posture)', () => {
    const input = getPermissionToolGateSnapshotInput();
    expect(input.enforce).toBe(true);
    expect(input.sessionGrants).toEqual([]);
    expect(input.perToolOverrides).toEqual({});
  });

  it('returns copies, not references into live store collections', () => {
    const state = usePermissionPolicyStore.getState();
    const input = buildPermissionToolGateSnapshotInput(state);
    expect(input.policies).not.toBe(state.policies);
    expect(input.perToolOverrides).not.toBe(state.perToolOverrides);
  });
});
