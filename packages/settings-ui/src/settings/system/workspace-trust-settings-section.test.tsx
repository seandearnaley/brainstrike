import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { describe, expect, it } from 'vitest';
import type {
  WorkspaceTrustCapability,
  WorkspaceTrustDecision,
  WorkspaceTrustRoot,
} from './workspace-trust';
import { WorkspaceTrustSettingsSection } from './workspace-trust-settings-section';

const CLONED: WorkspaceTrustRoot = {
  agentConfiguration: { commands: 1, instructions: 'AGENTS.md', personas: 0, skills: 2 },
  displayName: 'cloned-repo',
  path: '/work/cloned-repo',
  rootId: 'root-cloned',
  trust: 'undecided',
};
const NOTES: WorkspaceTrustRoot = {
  agentConfiguration: { commands: 0, instructions: null, personas: 0, skills: 0 },
  displayName: 'notes',
  path: '/work/notes',
  rootId: 'root-notes',
  trust: 'trusted',
};

/** The agent host's trust, kept in memory: each answer replaces the folder's record. */
function hostTrust(roots: readonly WorkspaceTrustRoot[]): WorkspaceTrustCapability {
  const answers = new Map<string, WorkspaceTrustDecision>();
  return {
    listTrust: async () =>
      roots.map((root) => ({ ...root, trust: answers.get(root.path) ?? root.trust })),
    setTrust: async (path, trust) => {
      answers.set(path, trust);
    },
  };
}

describe('WorkspaceTrustSettingsSection', () => {
  it('lists each folder with its answer and what trusting it loads', async () => {
    render(<WorkspaceTrustSettingsSection trust={hostTrust([CLONED, NOTES])} />);

    const cloned = await screen.findByTestId('workspace-trust-root-root-cloned');
    expect(cloned).toHaveTextContent('Not trusted yet');
    expect(cloned).toHaveTextContent('Holds AGENTS.md, 2 skills, and 1 slash command.');
    const notes = screen.getByTestId('workspace-trust-root-root-notes');
    expect(notes).toHaveTextContent('Trusted');
    expect(notes).toHaveTextContent('Holds no agent configuration.');
  });

  it('records an answer with the host and shows it, both ways', async () => {
    const user = userEvent.setup();
    render(<WorkspaceTrustSettingsSection trust={hostTrust([CLONED])} />);

    const row = await screen.findByTestId('workspace-trust-root-root-cloned');
    await user.click(within(row).getByRole('button', { name: 'Trust' }));
    await waitFor(() => expect(row).toHaveTextContent('Trusted'));

    await user.click(within(row).getByRole('button', { name: 'Restrict' }));
    await waitFor(() => expect(row).toHaveTextContent('Restricted'));
    expect(within(row).getByRole('button', { name: 'Trust' })).toBeEnabled();
  });

  it('shows a refused answer and keeps the folder as it was', async () => {
    const user = userEvent.setup();
    const trust: WorkspaceTrustCapability = {
      listTrust: async () => [CLONED],
      setTrust: () => Promise.reject(new Error('Workspace trust needs an absolute folder path')),
    };
    render(<WorkspaceTrustSettingsSection trust={trust} />);

    const row = await screen.findByTestId('workspace-trust-root-root-cloned');
    await user.click(within(row).getByRole('button', { name: 'Trust' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Workspace trust needs an absolute folder path'
    );
    expect(row).toHaveTextContent('Not trusted yet');
  });

  it('reports an unreadable list as a failure, never as no folders, and retries', async () => {
    const user = userEvent.setup();
    let reads = 0;
    const trust: WorkspaceTrustCapability = {
      listTrust: async () => {
        reads += 1;
        if (reads === 1) {
          throw new Error('The agent host is not running');
        }
        return [CLONED];
      },
      setTrust: async () => undefined,
    };
    render(<WorkspaceTrustSettingsSection trust={trust} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('The agent host is not running');
    expect(screen.queryByTestId('workspace-trust-no-roots')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('workspace-trust-root-root-cloned')).toBeInTheDocument();
  });
});
