import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';
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

/** A managed worktree of cloned-repo: its repository answers for it. */
const BADGER: WorkspaceTrustRoot = {
  agentConfiguration: { commands: 0, instructions: 'AGENTS.md', personas: 0, skills: 2 },
  answeredBy: { displayName: 'cloned-repo', path: '/work/cloned-repo' },
  displayName: 'swift-badger',
  path: '/managed/cloned-repo/swift-badger',
  rootId: 'root-badger',
  trust: 'undecided',
};

/** The folder cloned-repo and notes are kept in, which a trust ask may offer as a location. */
const WORK = '/work';

/**
 * The agent host's trust, kept in memory: each answer replaces the record of
 * the folder that answers, and every folder that shares it reads it. A folder
 * with no answer inside a trusted location is trusted through it, and the
 * parent of a folder not yet trusted is offered until it is a location.
 */
function hostTrust(
  roots: readonly WorkspaceTrustRoot[],
  trustedLocations: readonly string[] = []
): WorkspaceTrustCapability {
  const answers = new Map<string, WorkspaceTrustDecision>();
  const locations = new Set(trustedLocations);
  return {
    listTrust: async () =>
      roots.map(({ offeredLocation, ...root }) => {
        const folder = root.answeredBy?.path ?? root.path;
        const answer = answers.get(folder) ?? (root.trust === 'undecided' ? undefined : root.trust);
        const through = [...locations].find((location) => folder.startsWith(`${location}/`));
        const trust = answer ?? (through ? 'trusted' : 'undecided');
        return {
          ...root,
          ...(trust !== 'trusted' && offeredLocation && !locations.has(offeredLocation)
            ? { offeredLocation }
            : {}),
          trust,
          ...(answer === undefined && through ? { trustedThrough: through } : {}),
        };
      }),
    listTrustedLocations: async () => [...locations].map((path) => ({ path })),
    removeTrustedLocation: async (path) => {
      locations.delete(path);
    },
    setTrust: async (path, trust, location) => {
      answers.set(path, trust);
      if (location) {
        locations.add(location);
      }
    },
  };
}

/** A host that answers nothing about locations, for tests that never reach them. */
const NO_LOCATIONS = {
  listTrustedLocations: async () => [],
  removeTrustedLocation: async () => undefined,
};

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

  it('shows a worktree under its repository’s one answer, never as a decision of its own', async () => {
    const user = userEvent.setup();
    render(<WorkspaceTrustSettingsSection trust={hostTrust([CLONED, BADGER, NOTES])} />);

    const repository = await screen.findByTestId('workspace-trust-root-root-cloned');
    expect(screen.queryByTestId('workspace-trust-root-root-badger')).not.toBeInTheDocument();
    expect(repository).toHaveTextContent('Not trusted yet');
    expect(repository).toHaveTextContent('Holds AGENTS.md, 2 skills, and 1 slash command.');
    expect(repository).toHaveTextContent('Its worktrees share this answer');
    expect(repository).toHaveTextContent('swift-badger holds AGENTS.md and 2 skills.');
    expect(within(repository).getAllByRole('button')).toHaveLength(1);

    await user.click(within(repository).getByRole('button', { name: 'Trust' }));
    await waitFor(() => expect(repository).toHaveTextContent('Trusted'));
    expect(within(repository).getByRole('button', { name: 'Restrict' })).toBeEnabled();
  });

  it('names the repository a worktree shares its answer with when only the worktree is open', async () => {
    const user = userEvent.setup();
    const trust = hostTrust([BADGER]);
    const setTrust = vi.spyOn(trust, 'setTrust');
    render(<WorkspaceTrustSettingsSection trust={trust} />);

    const repository = await screen.findByTestId('workspace-trust-root-root-badger');
    expect(repository).toHaveTextContent('cloned-repo');
    expect(repository).toHaveTextContent('/work/cloned-repo');
    expect(repository).toHaveTextContent('Its worktrees share this answer');
    expect(repository).toHaveTextContent('swift-badger holds AGENTS.md and 2 skills.');

    await user.click(within(repository).getByRole('button', { name: 'Trust' }));
    await waitFor(() => expect(repository).toHaveTextContent('Trusted'));
    // The answer is the repository's, so it is given for the repository.
    expect(setTrust).toHaveBeenCalledExactlyOnceWith('/work/cloned-repo', 'trusted');
  });

  it('shows a refused answer and keeps the folder as it was', async () => {
    const user = userEvent.setup();
    const trust: WorkspaceTrustCapability = {
      ...NO_LOCATIONS,
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
      ...NO_LOCATIONS,
      setTrust: async () => undefined,
    };
    render(<WorkspaceTrustSettingsSection trust={trust} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('The agent host is not running');
    expect(screen.queryByTestId('workspace-trust-no-roots')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('workspace-trust-root-root-cloned')).toBeInTheDocument();
  });

  it('offers to also trust everything in the folder’s parent, unticked, and records it only when ticked', async () => {
    const user = userEvent.setup();
    const trust = hostTrust([{ ...CLONED, offeredLocation: WORK }]);
    const setTrust = vi.spyOn(trust, 'setTrust');
    render(<WorkspaceTrustSettingsSection trust={trust} />);

    const row = await screen.findByTestId('workspace-trust-root-root-cloned');
    const box = within(row).getByRole('checkbox', { name: 'Also trust every folder in /work' });
    expect(box).not.toBeChecked();
    expect(await screen.findByTestId('workspace-trust-no-locations')).toBeInTheDocument();

    await user.click(box);
    await user.click(within(row).getByRole('button', { name: 'Trust' }));

    expect(setTrust).toHaveBeenCalledExactlyOnceWith('/work/cloned-repo', 'trusted', WORK);
    await waitFor(() => expect(row).toHaveTextContent('Trusted'));
    // The parent is now listed as a trusted location, and the offer has gone.
    expect(await screen.findByTestId('workspace-trust-location-/work')).toHaveTextContent(WORK);
    expect(within(row).queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('offers the box unticked again after the person backs out of the location', async () => {
    const user = userEvent.setup();
    const trust = hostTrust([{ ...CLONED, offeredLocation: WORK }]);
    const setTrust = vi.spyOn(trust, 'setTrust');
    render(<WorkspaceTrustSettingsSection trust={trust} />);
    const row = await screen.findByTestId('workspace-trust-root-root-cloned');
    const parentBox = { name: 'Also trust every folder in /work' };

    // Trust with the box ticked, then take it all back: remove the location and restrict the folder.
    await user.click(within(row).getByRole('checkbox', parentBox));
    await user.click(within(row).getByRole('button', { name: 'Trust' }));
    const location = await screen.findByTestId('workspace-trust-location-/work');
    await user.click(within(location).getByRole('button', { name: 'Remove /work' }));
    await user.click(await within(row).findByRole('button', { name: 'Restrict' }));

    // The offer is back, and it starts unticked: trusting again trusts the folder alone.
    expect(await within(row).findByRole('checkbox', parentBox)).not.toBeChecked();
    await user.click(within(row).getByRole('button', { name: 'Trust' }));
    await waitFor(() => expect(row).toHaveTextContent('Trusted'));
    expect(setTrust).toHaveBeenLastCalledWith('/work/cloned-repo', 'trusted');
    expect(screen.getByTestId('workspace-trust-no-locations')).toBeInTheDocument();
  });

  it('trusts the folder alone when its box stays unticked', async () => {
    const user = userEvent.setup();
    const trust = hostTrust([{ ...CLONED, offeredLocation: WORK }]);
    const setTrust = vi.spyOn(trust, 'setTrust');
    render(<WorkspaceTrustSettingsSection trust={trust} />);

    const row = await screen.findByTestId('workspace-trust-root-root-cloned');
    await user.click(within(row).getByRole('button', { name: 'Trust' }));

    expect(setTrust).toHaveBeenCalledExactlyOnceWith('/work/cloned-repo', 'trusted');
    await waitFor(() => expect(row).toHaveTextContent('Trusted'));
    expect(screen.getByTestId('workspace-trust-no-locations')).toBeInTheDocument();
  });

  it('says which trusted location a folder is trusted through, and restricting it still works', async () => {
    const user = userEvent.setup();
    render(<WorkspaceTrustSettingsSection trust={hostTrust([CLONED], [WORK])} />);

    const row = await screen.findByTestId('workspace-trust-root-root-cloned');
    expect(row).toHaveTextContent('Trusted');
    expect(row).toHaveTextContent('Trusted because it is in the trusted location /work.');

    await user.click(within(row).getByRole('button', { name: 'Restrict' }));
    await waitFor(() => expect(row).toHaveTextContent('Restricted'));
    expect(row).not.toHaveTextContent('Trusted because');
  });

  it('removes a trusted location: a folder trusted only through it asks again, and an answered one keeps its answer', async () => {
    const user = userEvent.setup();
    const answered = { ...NOTES, path: '/work/notes' };
    render(<WorkspaceTrustSettingsSection trust={hostTrust([CLONED, answered], [WORK])} />);

    const location = await screen.findByTestId('workspace-trust-location-/work');
    const cloned = await screen.findByTestId('workspace-trust-root-root-cloned');
    expect(cloned).toHaveTextContent('Trusted');
    await user.click(within(location).getByRole('button', { name: 'Remove /work' }));

    await waitFor(() => expect(cloned).toHaveTextContent('Not trusted yet'));
    expect(screen.getByTestId('workspace-trust-root-root-notes')).toHaveTextContent('Trusted');
    expect(screen.queryByTestId('workspace-trust-location-/work')).not.toBeInTheDocument();
    expect(screen.getByTestId('workspace-trust-no-locations')).toBeInTheDocument();
  });

  it('shows a refused removal and keeps the location listed', async () => {
    const user = userEvent.setup();
    const trust: WorkspaceTrustCapability = {
      ...hostTrust([CLONED], [WORK]),
      removeTrustedLocation: () => Promise.reject(new Error('The agent host is not running')),
    };
    render(<WorkspaceTrustSettingsSection trust={trust} />);

    const location = await screen.findByTestId('workspace-trust-location-/work');
    await user.click(within(location).getByRole('button', { name: 'Remove /work' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The agent host is not running');
    expect(screen.getByTestId('workspace-trust-location-/work')).toBeInTheDocument();
  });

  it('reports an unreadable locations list as a failure, never as no locations', async () => {
    const trust: WorkspaceTrustCapability = {
      ...hostTrust([CLONED]),
      listTrustedLocations: () => Promise.reject(new Error('The agent host is not running')),
    };
    render(<WorkspaceTrustSettingsSection trust={trust} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('The agent host is not running');
    expect(screen.queryByTestId('workspace-trust-no-locations')).not.toBeInTheDocument();
  });
});
