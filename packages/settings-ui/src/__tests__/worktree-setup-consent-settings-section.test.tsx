import type { WorktreeSetupConsent } from '@brainstrike/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  WorktreeSetupConsentSettingsSection,
  type WorktreeSetupConsents,
} from '../settings/system/worktree-setup-consent-settings-section';

/** The host's recorded answers, in memory. */
function hostConsents(initial: readonly WorktreeSetupConsent[]): WorktreeSetupConsents & {
  readonly answers: WorktreeSetupConsent[];
} {
  const answers = [...initial];
  return {
    answers,
    list: vi.fn(async () => [...answers]),
    revoke: vi.fn(async (repositoryId: string) => {
      const index = answers.findIndex((answer) => answer.repositoryId === repositoryId);
      if (index >= 0) {
        answers.splice(index, 1);
      }
    }),
  };
}

function answer(
  repositoryId: string,
  decision: WorktreeSetupConsent['decision']
): WorktreeSetupConsent {
  return {
    decidedAt: '2026-11-12T00:00:00.000Z',
    decision,
    repositoryId,
    scriptSha256: 'a'.repeat(64),
  };
}

/** ADR-0034: Settings lists the setup script answers the host keeps, and revokes one. */
describe('WorktreeSetupConsentSettingsSection', () => {
  it('says when no repository has a standing answer', async () => {
    render(<WorktreeSetupConsentSettingsSection consents={hostConsents([])} />);
    expect(await screen.findByTestId('worktree-setup-consent-empty')).not.toBeNull();
  });

  it('lists each repository’s answer from the host', async () => {
    render(
      <WorktreeSetupConsentSettingsSection
        consents={hostConsents([
          answer('/repos/allowed/.git', 'approved'),
          answer('/repos/skipped/.git', 'denied'),
        ])}
      />
    );

    expect(
      (await screen.findByTestId('worktree-setup-consent-/repos/allowed/.git')).textContent
    ).toContain('Allowed');
    expect(screen.getByTestId('worktree-setup-consent-/repos/skipped/.git').textContent).toContain(
      'Skipped'
    );
  });

  it('revokes an answer with the host, so the repository’s next worktree asks again', async () => {
    const consents = hostConsents([answer('/repos/allowed/.git', 'approved')]);
    render(<WorktreeSetupConsentSettingsSection consents={consents} />);

    fireEvent.click(await screen.findByTestId('worktree-setup-consent-revoke-/repos/allowed/.git'));

    expect(await screen.findByTestId('worktree-setup-consent-empty')).not.toBeNull();
    expect(consents.revoke).toHaveBeenCalledWith('/repos/allowed/.git');
    expect(consents.answers).toEqual([]);
  });

  it('names a failed read and retries it', async () => {
    const consents = hostConsents([answer('/repos/allowed/.git', 'approved')]);
    vi.mocked(consents.list).mockRejectedValueOnce(new Error('host unavailable'));
    render(<WorktreeSetupConsentSettingsSection consents={consents} />);

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Unable to load setup script answers: host unavailable'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('worktree-setup-consent-/repos/allowed/.git')).not.toBeNull();
  });

  it('names a failed revoke and keeps the answer listed', async () => {
    const consents = hostConsents([answer('/repos/allowed/.git', 'approved')]);
    vi.mocked(consents.revoke).mockRejectedValueOnce(new Error('store locked'));
    render(<WorktreeSetupConsentSettingsSection consents={consents} />);

    fireEvent.click(await screen.findByTestId('worktree-setup-consent-revoke-/repos/allowed/.git'));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe(
        "Couldn't revoke /repos/allowed/.git: store locked"
      );
    });
    expect(screen.getByTestId('worktree-setup-consent-/repos/allowed/.git')).not.toBeNull();
  });
});
