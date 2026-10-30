import { resolvePermissionDecision } from '@brainstrike/assistant-contract/tool-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetPermissionPolicyStoreForTests,
  buildPermissionToolGateSnapshotInput,
  getPermissionToolGateSnapshotInput,
  restorePersistedPermissionPolicy,
  usePermissionPolicyStore,
} from '../stores/permission-policy-store.ts';

const STORE_KEY = 'permission-policy.v1';

function readPersistedState(): {
  access?: unknown;
  autoReviewModel?: unknown;
  enforce?: unknown;
  policies?: unknown;
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

  it('defaults to enforce ON, read:allow, edit/execute:ask, mcp:allow, ask access, no grants or overrides', () => {
    const state = usePermissionPolicyStore.getState();
    // enforce-on-by-default (P1 fix): read/mcp run free; edit/execute prompt.
    expect(state.enforce).toBe(true);
    expect(state.policies).toEqual({ edit: 'ask', execute: 'ask', mcp: 'allow', read: 'allow' });
    expect(state.access).toBe('ask');
    expect(state.autoReviewModel).toBe('auto');
    expect(state.sessionGrants.size).toBe(0);
    expect(state.perToolOverrides).toEqual({});
  });

  it('setEnforce toggles the enforcement switch (users can opt out)', async () => {
    expect(usePermissionPolicyStore.getState().enforce).toBe(true);
    await usePermissionPolicyStore.getState().setEnforce(false);
    expect(usePermissionPolicyStore.getState().enforce).toBe(false);
    await usePermissionPolicyStore.getState().setEnforce(true);
    expect(usePermissionPolicyStore.getState().enforce).toBe(true);
  });

  it('setCategoryPolicy updates one category only', async () => {
    await usePermissionPolicyStore.getState().setCategoryPolicy('execute', 'deny');
    const { policies } = usePermissionPolicyStore.getState();
    expect(policies.execute).toBe('deny');
    expect(policies.read).toBe('allow');
  });

  it('setAccess chooses the access mode', async () => {
    await usePermissionPolicyStore.getState().setAccess('full');
    expect(usePermissionPolicyStore.getState().access).toBe('full');
    await usePermissionPolicyStore.getState().setAccess('auto');
    expect(usePermissionPolicyStore.getState().access).toBe('auto');
  });

  it('grantSessionCategory promotes a category and feeds the resolver to allow', () => {
    usePermissionPolicyStore.getState().grantSessionCategory('edit');
    const state = usePermissionPolicyStore.getState();
    expect(state.sessionGrants.has('edit')).toBe(true);
    expect(
      resolvePermissionDecision({
        policies: state.policies,
        riskCategory: 'edit',
        sessionGrants: state.sessionGrants,
        yolo: false,
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

  it('grantAllSessionCategories grants read/edit/execute/mcp in ONE atomic set()', () => {
    let notifications = 0;
    const unsubscribe = usePermissionPolicyStore.subscribe(() => {
      notifications += 1;
    });
    try {
      usePermissionPolicyStore.getState().grantAllSessionCategories();
    } finally {
      unsubscribe();
    }

    const state = usePermissionPolicyStore.getState();
    expect(state.sessionGrants).toEqual(new Set(['read', 'edit', 'execute', 'mcp']));
    // Atomic: subscribers observe ONE update, never a partial grant set.
    expect(notifications).toBe(1);
    // The serializable snapshot carries all four.
    expect(buildPermissionToolGateSnapshotInput(state).sessionGrants.sort()).toEqual([
      'edit',
      'execute',
      'mcp',
      'read',
    ]);
  });

  it('grantAllSessionCategories leaves grants individually revocable', () => {
    usePermissionPolicyStore.getState().grantAllSessionCategories();
    usePermissionPolicyStore.getState().revokeSessionCategory('execute');
    const grants = usePermissionPolicyStore.getState().sessionGrants;
    expect(grants.has('execute')).toBe(false);
    expect(grants.has('read')).toBe(true);
    expect(grants.has('edit')).toBe(true);
    expect(grants.has('mcp')).toBe(true);
  });

  it('clearSessionGrants empties the session grant set', () => {
    usePermissionPolicyStore.getState().grantSessionCategory('edit');
    usePermissionPolicyStore.getState().grantSessionCategory('mcp');
    usePermissionPolicyStore.getState().clearSessionGrants();
    expect(usePermissionPolicyStore.getState().sessionGrants.size).toBe(0);
  });

  it('revokeSessionCategory removes only the named grant', () => {
    usePermissionPolicyStore.getState().grantSessionCategory('edit');
    usePermissionPolicyStore.getState().grantSessionCategory('mcp');
    usePermissionPolicyStore.getState().revokeSessionCategory('edit');
    const grants = usePermissionPolicyStore.getState().sessionGrants;
    expect(grants.has('edit')).toBe(false);
    expect(grants.has('mcp')).toBe(true);
  });

  it('revokeSessionCategory is a no-op when the grant is absent (same set identity guard)', () => {
    usePermissionPolicyStore.getState().grantSessionCategory('mcp');
    const first = usePermissionPolicyStore.getState().sessionGrants;
    usePermissionPolicyStore.getState().revokeSessionCategory('edit');
    expect(usePermissionPolicyStore.getState().sessionGrants).toBe(first);
  });

  it('setToolOverride sets and clears a per-tool override', async () => {
    await usePermissionPolicyStore.getState().setToolOverride('brainstrike.tool', 'deny');
    expect(usePermissionPolicyStore.getState().perToolOverrides['brainstrike.tool']).toBe('deny');

    await usePermissionPolicyStore.getState().setToolOverride('brainstrike.tool', null);
    expect(
      usePermissionPolicyStore.getState().perToolOverrides['brainstrike.tool']
    ).toBeUndefined();
  });

  it('does NOT persist sessionGrants (session-lived)', async () => {
    usePermissionPolicyStore.getState().grantSessionCategory('edit');
    await usePermissionPolicyStore.getState().setCategoryPolicy('execute', 'deny');

    const state = readPersistedState();
    // Persisted slice carries policies but never sessionGrants.
    expect(state.policies).toBeDefined();
    expect('sessionGrants' in state).toBe(false);
  });

  it('persists enforce, policies, access, auto-review model and perToolOverrides', async () => {
    const store = usePermissionPolicyStore.getState();
    await Promise.all([
      store.setEnforce(true),
      store.setAccess('auto'),
      store.setAutoReviewModel('anthropic/claude-haiku-4-5'),
      store.setToolOverride('brainstrike.tool', 'allow'),
    ]);

    const state = readPersistedState();
    expect(state.enforce).toBe(true);
    expect(state.access).toBe('auto');
    expect(state.autoReviewModel).toBe('anthropic/claude-haiku-4-5');
    expect(state.perToolOverrides).toEqual({ 'brainstrike.tool': 'allow' });
  });

  it('restoring self-heals malformed persisted policies and drops unknown categories', () => {
    const restored = restorePersistedPermissionPolicy(
      {
        access: 'yolo',
        perToolOverrides: { 'brainstrike.bad': 'maybe', 'brainstrike.ok': 'deny' },
        policies: { bogus: 'allow', edit: 'prompt', read: 'allow' },
        sessionGrants: ['execute'],
      },
      0
    );

    // edit:'prompt' is invalid -> default 'ask'; bogus dropped; mcp/execute defaulted.
    expect(restored.policies).toEqual({ edit: 'ask', execute: 'ask', mcp: 'allow', read: 'allow' });
    // enforce absent from the legacy slice -> adopts the new secure default (ON).
    expect(restored.enforce).toBe(true);
    // An unknown access mode -> ask.
    expect(restored.access).toBe('ask');
    // invalid override dropped, valid kept.
    expect(restored.perToolOverrides).toEqual({ 'brainstrike.ok': 'deny' });
    // session grants are never restored.
    expect('sessionGrants' in restored).toBe(false);
  });

  it('reset clears both in-memory state and persisted storage', async () => {
    const store = usePermissionPolicyStore.getState();
    await Promise.all([store.setEnforce(false), store.setAccess('full')]);
    store.grantSessionCategory('edit');
    expect(window.localStorage.getItem(STORE_KEY)).not.toBeNull();

    __resetPermissionPolicyStoreForTests();

    const state = usePermissionPolicyStore.getState();
    // Reset re-applies defaultData() → enforce ON (the secure default).
    expect(state.enforce).toBe(true);
    expect(state.access).toBe('ask');
    expect(state.sessionGrants.size).toBe(0);
    expect(state.policies).toEqual({ edit: 'ask', execute: 'ask', mcp: 'allow', read: 'allow' });
    await vi.waitFor(() => expect(window.localStorage.getItem(STORE_KEY)).toBeNull());
  });

  it('restoring adopts the secure default (enforce:true) for a PRE-V2 enforce:false slice', () => {
    // Under v1, `false` was the OLD DEFAULT (always written), indistinguishable
    // from an opt-out — a security fix adopts the secure default for pre-v2.
    const restored = restorePersistedPermissionPolicy(
      { enforce: false, policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'allow' } },
      1
    );
    expect(restored.enforce).toBe(true);
  });

  it('restoring preserves an explicit V2+ persisted enforce:false (post-default-on opt-out)', () => {
    // A v2 slice with enforce:false is a real opt-out made AFTER enforce went on
    // by default, so it is honored verbatim.
    const restored = restorePersistedPermissionPolicy(
      { enforce: false, policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'allow' } },
      2
    );
    expect(restored.enforce).toBe(false);
  });
});

describe('buildPermissionToolGateSnapshotInput / getPermissionToolGateSnapshotInput', () => {
  beforeEach(() => {
    __resetPermissionPolicyStoreForTests();
  });

  it('produces the serializable gate-input shape from store state (sessionGrants as array)', async () => {
    const store = usePermissionPolicyStore.getState();
    await Promise.all([
      store.setEnforce(true),
      store.setCategoryPolicy('edit', 'deny'),
      store.setToolOverride('brainstrike.tool', 'allow'),
    ]);
    store.grantSessionCategory('execute');

    const input = getPermissionToolGateSnapshotInput();

    expect(input.enforce).toBe(true);
    expect(input.policies).toEqual({
      edit: 'deny',
      execute: 'ask',
      mcp: 'allow',
      read: 'allow',
    });
    expect(input.yolo).toBe(false);
    // Set -> serializable array.
    expect(Array.isArray(input.sessionGrants)).toBe(true);
    expect(input.sessionGrants).toEqual(['execute']);
    expect(input.perToolOverrides).toEqual({ 'brainstrike.tool': 'allow' });
  });

  it('maps the access mode onto the gate: full allows everything, auto names its reviewer', async () => {
    const store = usePermissionPolicyStore.getState();
    await store.setAccess('full');
    expect(getPermissionToolGateSnapshotInput()).toMatchObject({ yolo: true });
    expect('autoReview' in getPermissionToolGateSnapshotInput()).toBe(false);

    await Promise.all([store.setAccess('auto'), store.setAutoReviewModel('openai/gpt-5.4-mini')]);
    expect(getPermissionToolGateSnapshotInput()).toMatchObject({
      autoReview: { model: 'openai/gpt-5.4-mini' },
      yolo: false,
    });
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
