import {
  __resetWorktreeSetupConsentStoreForTests,
  useWorktreeSetupConsentStore,
} from '@brainstrike/app-state/stores/worktree-setup-consent-store';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { WorktreeSetupConsentSettingsSection } from '../settings/system/worktree-setup-consent-settings-section';

beforeEach(() => {
  __resetWorktreeSetupConsentStoreForTests();
});

describe('WorktreeSetupConsentSettingsSection', () => {
  it('shows an empty state when no repository has a standing decision', () => {
    render(<WorktreeSetupConsentSettingsSection />);
    expect(screen.getByTestId('worktree-setup-consent-empty')).not.toBeNull();
  });

  it('lists each repository decision with its badge and a Revoke action', () => {
    useWorktreeSetupConsentStore.getState().decide('/repos/allowed/.git', 'approved', 'hash-a');
    useWorktreeSetupConsentStore.getState().decide('/repos/skipped/.git', 'denied', 'hash-d');

    render(<WorktreeSetupConsentSettingsSection />);

    expect(screen.getByTestId('worktree-setup-consent-/repos/allowed/.git').textContent).toContain(
      'Allowed'
    );
    expect(screen.getByTestId('worktree-setup-consent-/repos/skipped/.git').textContent).toContain(
      'Skipped'
    );
  });

  it('revoking a decision clears it from the store — the next create re-prompts', () => {
    useWorktreeSetupConsentStore.getState().decide('/repos/allowed/.git', 'approved', 'hash-a');
    render(<WorktreeSetupConsentSettingsSection />);

    fireEvent.click(screen.getByTestId('worktree-setup-consent-revoke-/repos/allowed/.git'));

    expect(useWorktreeSetupConsentStore.getState().decisionsByRepositoryId).toEqual({});
    expect(screen.getByTestId('worktree-setup-consent-empty')).not.toBeNull();
  });
});
