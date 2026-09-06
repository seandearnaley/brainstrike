import { beforeEach, describe, expect, it } from 'vitest';
import { clearPersistentUiState } from '../factory-reset';
import {
  __resetWorktreeSetupConsentStoreForTests,
  useWorktreeSetupConsentStore,
} from '../stores/worktree-setup-consent-store';
import type { PersistApi } from './persist-api-test-helper';

const STORE_KEY = 'worktree-setup-consent.v1';
const storeWithPersist = useWorktreeSetupConsentStore as PersistApi<
  typeof useWorktreeSetupConsentStore
>;

describe('worktree-setup-consent-store', () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetWorktreeSetupConsentStoreForTests();
  });

  it('persists approvals and denials independently per repository, pinned to a script hash', () => {
    const store = useWorktreeSetupConsentStore.getState();
    store.decide('/repos/approved/.git', 'approved', 'hash-a');
    store.decide('/repos/denied/.git', 'denied', 'hash-d');

    const { decisionsByRepositoryId } = useWorktreeSetupConsentStore.getState();
    expect(decisionsByRepositoryId['/repos/approved/.git']).toMatchObject({
      decision: 'approved',
      scriptSha256: 'hash-a',
    });
    expect(decisionsByRepositoryId['/repos/denied/.git']).toMatchObject({
      decision: 'denied',
      scriptSha256: 'hash-d',
    });
    expect(typeof decisionsByRepositoryId['/repos/approved/.git']?.decidedAt).toBe('number');
    expect(JSON.parse(window.localStorage.getItem(STORE_KEY) ?? '{}')).toMatchObject({
      state: {
        decisionsByRepositoryId: {
          '/repos/approved/.git': { decision: 'approved', scriptSha256: 'hash-a' },
          '/repos/denied/.git': { decision: 'denied', scriptSha256: 'hash-d' },
        },
      },
    });
  });

  it('throws rather than recording a decision with no script hash', () => {
    const store = useWorktreeSetupConsentStore.getState();
    expect(() => store.decide('/repos/app/.git', 'approved', '')).toThrow(
      'Worktree setup consent requires the script hash it is pinned to.'
    );
  });

  it('revoke clears a repository decision so its next create re-prompts', () => {
    const store = useWorktreeSetupConsentStore.getState();
    store.decide('/repos/app/.git', 'approved', 'hash-a');
    expect(useWorktreeSetupConsentStore.getState().decisionsByRepositoryId).toHaveProperty(
      '/repos/app/.git'
    );

    store.revoke('/repos/app/.git');

    expect(useWorktreeSetupConsentStore.getState().decisionsByRepositoryId).toEqual({});
  });

  it('revoking an undecided repository is a no-op', () => {
    const before = useWorktreeSetupConsentStore.getState().decisionsByRepositoryId;
    useWorktreeSetupConsentStore.getState().revoke('/repos/never-decided/.git');
    expect(useWorktreeSetupConsentStore.getState().decisionsByRepositoryId).toBe(before);
  });

  it('rehydrates a persisted decision after a simulated restart', async () => {
    useWorktreeSetupConsentStore.getState().decide('/repos/app/.git', 'approved', 'hash-a');
    const persisted = window.localStorage.getItem(STORE_KEY);
    useWorktreeSetupConsentStore.setState({ decisionsByRepositoryId: {} });
    if (persisted === null) {
      throw new Error('expected persisted consent state');
    }
    window.localStorage.setItem(STORE_KEY, persisted);

    await storeWithPersist.persist.rehydrate();

    expect(
      useWorktreeSetupConsentStore.getState().decisionsByRepositoryId['/repos/app/.git']
    ).toMatchObject({ decision: 'approved', scriptSha256: 'hash-a' });
  });

  it('drops malformed persisted decisions fail-closed', () => {
    const migrate = storeWithPersist.persist.getOptions().migrate;
    expect(
      migrate?.(
        {
          decisionsByRepositoryId: {
            bad: 'maybe',
            good: { decidedAt: 5, decision: 'denied', scriptSha256: 'hash-g' },
          },
        },
        1
      )
    ).toEqual({
      decisionsByRepositoryId: {
        good: { decidedAt: 5, decision: 'denied', scriptSha256: 'hash-g' },
      },
    });
  });

  it('drops the pre-hash bare-string shape fail-closed — that repository re-prompts', () => {
    const migrate = storeWithPersist.persist.getOptions().migrate;
    expect(
      migrate?.(
        {
          decisionsByRepositoryId: {
            '/repos/old-shape/.git': 'approved',
          },
        },
        1
      )
    ).toEqual({ decisionsByRepositoryId: {} });
  });

  it('drops a record missing its script hash fail-closed', () => {
    const migrate = storeWithPersist.persist.getOptions().migrate;
    expect(
      migrate?.(
        {
          decisionsByRepositoryId: {
            '/repos/hashless/.git': { decidedAt: 5, decision: 'approved' },
          },
        },
        1
      )
    ).toEqual({ decisionsByRepositoryId: {} });
  });

  it('drops every repository decision during factory reset', async () => {
    const store = useWorktreeSetupConsentStore.getState();
    store.decide('/repos/approved/.git', 'approved', 'hash-a');
    store.decide('/repos/denied/.git', 'denied', 'hash-d');

    await clearPersistentUiState({ skipIndexedDb: true });

    expect(useWorktreeSetupConsentStore.getState().decisionsByRepositoryId).toEqual({});
  });
});
