import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetHookTrustStoreForTests,
  buildHookTrustRequest,
  getHookTrustRequest,
  useHookTrustStore,
} from '../stores/hook-trust-store';
import type { PersistApi } from './persist-api-test-helper';

const storeWithPersist = useHookTrustStore as PersistApi<typeof useHookTrustStore>;

const STORE_KEY = 'hook-trust.v1';

function readPersistedState(): { approvalsByRootId?: unknown } {
  const raw = window.localStorage.getItem(STORE_KEY);
  if (raw === null) {
    throw new Error('expected persisted state in localStorage');
  }
  const parsed = JSON.parse(raw) as { state?: Record<string, unknown> };
  return parsed.state ?? {};
}

describe('hook-trust-store', () => {
  beforeEach(() => {
    __resetHookTrustStoreForTests();
  });

  it('defaults to an empty approvals map', () => {
    expect(useHookTrustStore.getState().approvalsByRootId).toEqual({});
    expect(getHookTrustRequest()).toEqual({ approvals: [] });
  });

  it('approves and revokes a root, persisting the approval', () => {
    useHookTrustStore.getState().approveRoot('r1', 'hash-1');
    const approval = useHookTrustStore.getState().approvalsByRootId['r1'];
    expect(approval?.sha256).toBe('hash-1');
    expect(typeof approval?.approvedAt).toBe('number');

    const persisted = readPersistedState().approvalsByRootId as Record<string, { sha256: string }>;
    expect(persisted['r1']?.sha256).toBe('hash-1');

    useHookTrustStore.getState().revokeRoot('r1');
    expect(useHookTrustStore.getState().approvalsByRootId['r1']).toBeUndefined();
  });

  it('builds a wire request that mirrors the approvals map', () => {
    useHookTrustStore.getState().approveRoot('r1', 'hash-1');
    useHookTrustStore.getState().approveRoot('r2', 'hash-2');
    const request = buildHookTrustRequest(useHookTrustStore.getState());
    expect(request.approvals).toHaveLength(2);
    const byRoot = new Map(request.approvals.map((a) => [a.rootId, a.sha256]));
    expect(byRoot.get('r1')).toBe('hash-1');
    expect(byRoot.get('r2')).toBe('hash-2');
  });

  it('migrates garbage persisted state to defaults', () => {
    const migrate = storeWithPersist.persist.getOptions().migrate;
    expect(migrate).toBeDefined();
    expect(migrate?.(null, 0)).toEqual({ approvalsByRootId: {} });
    expect(migrate?.('nonsense', 0)).toEqual({ approvalsByRootId: {} });
    expect(migrate?.({ approvalsByRootId: { r1: { approvedAt: 5, sha256: 'h' } } }, 1)).toEqual({
      approvalsByRootId: { r1: { approvedAt: 5, sha256: 'h' } },
    });
    // Malformed entries are dropped.
    expect(migrate?.({ approvalsByRootId: { bad: { sha256: 123 } } }, 1)).toEqual({
      approvalsByRootId: {},
    });
  });

  it('resets to defaults, dropping every persisted approval', () => {
    useHookTrustStore.getState().approveRoot('r1', 'hash-1');
    __resetHookTrustStoreForTests();
    expect(useHookTrustStore.getState().approvalsByRootId).toEqual({});
    // setState(defaults) re-persists the empty slice (matches permission store).
    expect(readPersistedState().approvalsByRootId).toEqual({});
  });
});
