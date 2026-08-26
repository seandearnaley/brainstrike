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

  it('persists approvals and denials independently per repository', () => {
    const store = useWorktreeSetupConsentStore.getState();
    store.decide('/repos/approved/.git', 'approved');
    store.decide('/repos/denied/.git', 'denied');

    expect(useWorktreeSetupConsentStore.getState().decisionsByRepositoryId).toEqual({
      '/repos/approved/.git': 'approved',
      '/repos/denied/.git': 'denied',
    });
    expect(JSON.parse(window.localStorage.getItem(STORE_KEY) ?? '{}')).toMatchObject({
      state: {
        decisionsByRepositoryId: {
          '/repos/approved/.git': 'approved',
          '/repos/denied/.git': 'denied',
        },
      },
    });
  });

  it('rehydrates a persisted decision after a simulated restart', async () => {
    useWorktreeSetupConsentStore.getState().decide('/repos/app/.git', 'approved');
    const persisted = window.localStorage.getItem(STORE_KEY);
    useWorktreeSetupConsentStore.setState({ decisionsByRepositoryId: {} });
    if (persisted === null) {
      throw new Error('expected persisted consent state');
    }
    window.localStorage.setItem(STORE_KEY, persisted);

    await storeWithPersist.persist.rehydrate();

    expect(useWorktreeSetupConsentStore.getState().decisionsByRepositoryId).toEqual({
      '/repos/app/.git': 'approved',
    });
  });

  it('drops malformed persisted decisions fail-closed', () => {
    const migrate = storeWithPersist.persist.getOptions().migrate;
    expect(
      migrate?.(
        {
          decisionsByRepositoryId: {
            bad: 'maybe',
            good: 'denied',
          },
        },
        1
      )
    ).toEqual({ decisionsByRepositoryId: { good: 'denied' } });
  });

  it('drops every repository decision during factory reset', async () => {
    const store = useWorktreeSetupConsentStore.getState();
    store.decide('/repos/approved/.git', 'approved');
    store.decide('/repos/denied/.git', 'denied');

    await clearPersistentUiState({ skipIndexedDb: true });

    expect(useWorktreeSetupConsentStore.getState().decisionsByRepositoryId).toEqual({});
  });
});
