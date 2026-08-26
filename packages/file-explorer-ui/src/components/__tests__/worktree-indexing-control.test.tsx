import {
  __resetBackgroundIndexingPreferencesStoreForTests,
  useBackgroundIndexingPreferencesStore,
} from '@brainstrike/app-state/stores/background-indexing-preferences-store';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { WorktreeIndexingControl } from '../worktree-indexing-control';

describe('WorktreeIndexingControl', () => {
  beforeEach(() => {
    __resetBackgroundIndexingPreferencesStoreForTests();
  });

  it('explains the default exclusion and opts only this root into indexing', async () => {
    useBackgroundIndexingPreferencesStore.getState().setWorktreeRootIndexingState([
      { adapterRootId: 'adapter-a', dbRootId: 'db-a', indexed: false },
      { adapterRootId: 'adapter-b', dbRootId: 'db-b', indexed: false },
    ]);
    render(<WorktreeIndexingControl rootId="adapter-a" />);

    await userEvent.click(screen.getByRole('button', { name: /Not indexed/ }));

    expect(
      screen.getByText(/excluded by default to avoid duplicate corpus indexing/i)
    ).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Index this worktree' }));

    expect(useBackgroundIndexingPreferencesStore.getState().worktreeRootIndexingOptInById).toEqual({
      'db-a': true,
    });
  });

  it('renders nothing for a root that is not a managed worktree', () => {
    render(<WorktreeIndexingControl rootId="path-root" />);

    expect(screen.queryByRole('button')).toBeNull();
  });
});
