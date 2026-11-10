/**
 * ADR-0032 — the composer's workspace trust chip, from the thread's side: it
 * counts what the thread's own folders hold back, asks once per answer,
 * records the person's answer with the host, and stays out of the way
 * otherwise.
 */
import '@testing-library/jest-dom/vitest';
import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import type { WorkspaceBarProps } from '@brainstrike/assistant-ui';
import type {
  WorkspaceTrustDecision,
  WorkspaceTrustRoot,
} from '@brainstrike/settings-ui/settings/system/workspace-trust';
import { act } from '@brainstrike/test-utils/react-act';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantHostWorkspaceDiscovery } from '../assistant-thread-host-context';
import { WorkspaceBarHost } from '../workspace-bar/workspace-bar-host';
import { notifyWorkspaceTrustChanged } from '../workspace-trust/workspace-trust-revision';

// The bar's own folder, branch and checkout chips are covered where they live.
const BAR: WorkspaceBarProps = {
  onAddFolder: () => undefined,
  onAddWorkspaceFolder: () => undefined,
  onMakePrimary: () => undefined,
  onRemovePrimary: () => undefined,
  onRemoveSecondary: () => undefined,
  onUseFolder: () => undefined,
  recentRoots: [],
  secondaryRoots: [],
  workspaceFolders: [],
};
vi.mock('../hooks/use-workspace-bar', () => ({ useWorkspaceBar: () => BAR }));

const hostState: {
  host: { readonly workspaceDiscovery: AssistantHostWorkspaceDiscovery } | undefined;
} = { host: undefined };
vi.mock('../assistant-thread-host-context', () => ({
  useAssistantThreadHost: () => hostState.host,
}));

const RESOURCE_ID = 'workspace-a';
const THREAD_ID = 'thread-1';

const CLONED: WorkspaceTrustRoot = {
  agentConfiguration: { commands: 0, instructions: 'AGENTS.md', personas: 1, skills: 2 },
  displayName: 'cloned-repo',
  path: '/work/cloned-repo',
  rootId: 'root-cloned',
  trust: 'undecided',
};
const NOTES: WorkspaceTrustRoot = {
  agentConfiguration: { commands: 1, instructions: 'CLAUDE.md', personas: 0, skills: 0 },
  displayName: 'notes',
  path: '/work/notes',
  rootId: 'root-notes',
  trust: 'undecided',
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

function root(overrides: Partial<WorkspaceTrustRoot>): WorkspaceTrustRoot {
  return { ...CLONED, ...overrides };
}

/** The chip never lists or removes trusted locations; Settings does. */
const LOCATIONS_NOT_UNDER_TEST = {
  listTrustedLocations: () => Promise.reject(new Error('The locations list is not under test')),
  removeTrustedLocation: () => Promise.reject(new Error('Removing a location is not under test')),
};

/** The thread's folders, as its binding names them; none leaves the thread without a folder. */
function seedThread(folders: readonly WorkspaceTrustRoot[]): void {
  const [primary, ...secondaries] = folders;
  useAssistantThreadStore.setState({
    ...useAssistantThreadStore.getState(),
    threadsByResourceId: {
      [RESOURCE_ID]: [
        {
          createdAt: new Date(),
          id: THREAD_ID,
          metadata: primary
            ? {
                operatingRootDisplayName: primary.displayName,
                operatingRootId: primary.rootId,
                operatingRootPath: primary.path,
                secondaryRootIds: secondaries.map((folder) => folder.rootId),
              }
            : {},
          resourceId: RESOURCE_ID,
          title: 't',
          updatedAt: new Date(),
        },
      ],
    },
  });
}

/**
 * The desktop's host discovery, with trust kept in memory: an answer is the
 * answering folder's, every folder that shares it reads it, and, like the
 * desktop capability, a recorded answer tells every trust reader to read again.
 */
function setHost(
  roots: readonly WorkspaceTrustRoot[],
  refusal?: Error
): {
  readonly listTrust: () => Promise<readonly WorkspaceTrustRoot[]>;
  readonly setTrust: (
    path: string,
    trust: WorkspaceTrustDecision,
    location?: string
  ) => Promise<void>;
} {
  const answers = new Map<string, WorkspaceTrustDecision>();
  const listTrust = vi.fn(async () =>
    roots.map((entry) => ({
      ...entry,
      trust: answers.get(entry.answeredBy?.path ?? entry.path) ?? entry.trust,
    }))
  );
  const setTrust = vi.fn(
    async (path: string, trust: WorkspaceTrustDecision, _location?: string) => {
      if (refusal) {
        throw refusal;
      }
      answers.set(path, trust);
      notifyWorkspaceTrustChanged();
    }
  );
  hostState.host = {
    workspaceDiscovery: {
      listCommands: () => Promise.reject(new Error('Commands are not under test')),
      listTrust,
      ...LOCATIONS_NOT_UNDER_TEST,
      scanSkills: () => Promise.reject(new Error('Skills are not under test')),
      setTrust,
    },
  };
  return { listTrust, setTrust };
}

function renderComposerBar(): void {
  render(
    <WorkspaceBarHost
      assistantThreadRepository={null}
      memoryResourceId={RESOURCE_ID}
      rootDescriptors={undefined}
      selectedMemoryThreadId={THREAD_ID}
    />
  );
}

/** Radix popovers need the pointer-events check off in a headless DOM. */
function setup() {
  return userEvent.setup({ pointerEventsCheck: 0 });
}

const chipName = /^Workspace trust:/u;

async function openTrust(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: chipName }));
  return await screen.findByRole('dialog', { name: 'Workspace trust' });
}

afterEach(() => {
  hostState.host = undefined;
  useAssistantThreadStore.setState({
    ...useAssistantThreadStore.getState(),
    threadsByResourceId: {},
  });
});

describe('the composer workspace trust chip', () => {
  it('counts what the thread’s folder holds back and opens to the question', async () => {
    const user = setup();
    seedThread([CLONED]);
    setHost([CLONED]);
    renderComposerBar();

    expect(
      await screen.findByRole('button', { name: 'Workspace trust: 4 held' })
    ).toBeInTheDocument();
    const ask = await openTrust(user);
    expect(ask).toHaveTextContent('Trust the files in cloned-repo?');
    expect(ask).toHaveTextContent('AGENTS.md, 2 skills, and 1 subagent');
  });

  it('asks only about the thread’s own folders, whatever else is open', async () => {
    const user = setup();
    seedThread([CLONED]);
    setHost([CLONED, NOTES]);
    renderComposerBar();

    expect(
      await screen.findByRole('button', { name: 'Workspace trust: 4 held' })
    ).toBeInTheDocument();
    const ask = await openTrust(user);
    expect(ask).not.toHaveTextContent('notes');
  });

  it('asks nothing in a thread none of whose folders are undecided', async () => {
    seedThread([CLONED]);
    const { listTrust } = setHost([root({ trust: 'trusted' }), NOTES]);
    renderComposerBar();

    await waitFor(() => expect(listTrust).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: chipName })).not.toBeInTheDocument();
  });

  it('asks about every open folder in a thread with no folder of its own, as its runs read them all', async () => {
    const user = setup();
    seedThread([]);
    setHost([CLONED, NOTES]);
    renderComposerBar();

    expect(
      await screen.findByRole('button', { name: 'Workspace trust: 6 held' })
    ).toBeInTheDocument();
    const ask = await openTrust(user);
    expect(ask).toHaveTextContent('Trust the files in cloned-repo?');
    expect(ask).toHaveTextContent('Trust the files in notes?');
  });

  it('asks nothing about a folder already answered or one with no agent configuration', async () => {
    seedThread([]);
    const { listTrust } = setHost([
      root({ rootId: 'root-trusted', trust: 'trusted' }),
      // Trusted with no answer of its own, through the trusted location it is kept in.
      root({ rootId: 'root-located', trust: 'trusted', trustedThrough: '/work' }),
      root({ rootId: 'root-restricted', trust: 'restricted' }),
      root({
        agentConfiguration: { commands: 0, instructions: null, personas: 0, skills: 0 },
        rootId: 'root-plain',
      }),
    ]);
    renderComposerBar();

    await waitFor(() => expect(listTrust).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: chipName })).not.toBeInTheDocument();
  });

  it('asks once for a worktree and its repository, naming the repository', async () => {
    const user = setup();
    seedThread([BADGER, CLONED]);
    const { setTrust } = setHost([CLONED, BADGER]);
    renderComposerBar();

    const ask = await openTrust(user);
    expect(ask).toHaveTextContent('Trust the files in cloned-repo?');
    expect(ask).not.toHaveTextContent('Trust the files in swift-badger?');
    expect(ask).toHaveTextContent('swift-badger: AGENTS.md and 2 skills');
    expect(ask).toHaveTextContent('cloned-repo: AGENTS.md, 2 skills, and 1 subagent');
    await user.click(within(ask).getByRole('button', { name: 'Trust folder' }));

    // One answer, the repository's, and both folders stop asking.
    expect(setTrust).toHaveBeenCalledExactlyOnceWith('/work/cloned-repo', 'trusted');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: chipName })).not.toBeInTheDocument()
    );
  });

  it('names the repository for a thread in a worktree whose repository is not open', async () => {
    const user = setup();
    seedThread([BADGER]);
    const { setTrust } = setHost([BADGER]);
    renderComposerBar();

    expect(
      await screen.findByRole('button', { name: 'Workspace trust: 3 held' })
    ).toBeInTheDocument();
    const ask = await openTrust(user);
    expect(ask).toHaveTextContent('Trust the files in cloned-repo?');
    expect(ask).toHaveTextContent('covers this repository and its worktrees');
    await user.click(within(ask).getByRole('button', { name: 'Keep restricted' }));

    expect(setTrust).toHaveBeenCalledExactlyOnceWith('/work/cloned-repo', 'restricted');
  });

  it.each([
    ['Trust folder', 'trusted'],
    ['Keep restricted', 'restricted'],
  ] as const)('"%s" records the answer and the chip leaves', async (label, decision) => {
    const user = setup();
    seedThread([CLONED]);
    const { setTrust } = setHost([CLONED]);
    renderComposerBar();

    const ask = await openTrust(user);
    await user.click(within(ask).getByRole('button', { name: label }));

    expect(setTrust).toHaveBeenCalledWith('/work/cloned-repo', decision);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: chipName })).not.toBeInTheDocument()
    );
  });

  it('shows a refused answer and keeps asking', async () => {
    const user = setup();
    seedThread([CLONED]);
    setHost([CLONED], new Error('The agent host is not running'));
    renderComposerBar();

    const ask = await openTrust(user);
    await user.click(within(ask).getByRole('button', { name: 'Trust folder' }));

    expect(await within(ask).findByRole('alert')).toHaveTextContent(
      'The agent host is not running'
    );
    expect(screen.getByRole('button', { name: 'Workspace trust: 4 held' })).toBeInTheDocument();
  });

  it('says when it cannot read trust, without the internal cause, and recovers on Retry', async () => {
    const user = setup();
    seedThread([CLONED]);
    const listTrust = vi
      .fn<() => Promise<readonly WorkspaceTrustRoot[]>>()
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED /run/agent-host.sock'))
      .mockResolvedValue([CLONED]);
    hostState.host = {
      workspaceDiscovery: {
        listCommands: () => Promise.reject(new Error('Commands are not under test')),
        listTrust,
        ...LOCATIONS_NOT_UNDER_TEST,
        scanSkills: () => Promise.reject(new Error('Skills are not under test')),
        setTrust: () => Promise.reject(new Error('Answers are not under test')),
      },
    };
    renderComposerBar();

    expect(
      await screen.findByRole('button', { name: 'Workspace trust: not checked' })
    ).toBeInTheDocument();
    const ask = await openTrust(user);
    const alert = within(ask).getByRole('alert');
    expect(alert).toHaveTextContent('couldn’t check whether this thread’s folders');
    expect(alert).not.toHaveTextContent('ECONNREFUSED');

    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByRole('button', { name: 'Workspace trust: 4 held' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('counts a folder that gained agent configuration when the window is shown again', async () => {
    seedThread([CLONED]);
    const roots: WorkspaceTrustRoot[] = [
      root({ agentConfiguration: { commands: 0, instructions: null, personas: 0, skills: 0 } }),
    ];
    const { listTrust } = setHost(roots);
    renderComposerBar();
    await waitFor(() => expect(listTrust).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: chipName })).not.toBeInTheDocument();

    // A git pull brings AGENTS.md while the person is in another window.
    roots[0] = CLONED;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(
      await screen.findByRole('button', { name: 'Workspace trust: 4 held' })
    ).toBeInTheDocument();
  });
});

describe('the offer to also trust everything in the folder’s parent', () => {
  const parentBox = { name: 'Also trust every folder in /work' };

  it('is unticked, names the parent, and leaves the parent alone unless ticked', async () => {
    const user = setup();
    seedThread([CLONED]);
    const { setTrust } = setHost([root({ offeredLocation: '/work' })]);
    renderComposerBar();

    const ask = await openTrust(user);
    expect(within(ask).getByRole('checkbox', parentBox)).not.toBeChecked();
    await user.click(within(ask).getByRole('button', { name: 'Trust folder' }));

    expect(setTrust).toHaveBeenCalledExactlyOnceWith('/work/cloned-repo', 'trusted');
  });

  it('records the parent as a trusted location when ticked and the folder is trusted', async () => {
    const user = setup();
    seedThread([CLONED]);
    const { setTrust } = setHost([root({ offeredLocation: '/work' })]);
    renderComposerBar();

    const ask = await openTrust(user);
    await user.click(within(ask).getByRole('checkbox', parentBox));
    expect(within(ask).getByRole('checkbox', parentBox)).toBeChecked();
    await user.click(within(ask).getByRole('button', { name: 'Trust folder' }));

    expect(setTrust).toHaveBeenCalledExactlyOnceWith('/work/cloned-repo', 'trusted', '/work');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: chipName })).not.toBeInTheDocument()
    );
  });

  it('never records the parent with "Keep restricted", even when ticked', async () => {
    const user = setup();
    seedThread([CLONED]);
    const { setTrust } = setHost([root({ offeredLocation: '/work' })]);
    renderComposerBar();

    const ask = await openTrust(user);
    await user.click(within(ask).getByRole('checkbox', parentBox));
    await user.click(within(ask).getByRole('button', { name: 'Keep restricted' }));

    expect(setTrust).toHaveBeenCalledExactlyOnceWith('/work/cloned-repo', 'restricted');
  });

  it('for a worktree, offers the parent of the repository the answer is for', async () => {
    const user = setup();
    seedThread([BADGER]);
    const { setTrust } = setHost([{ ...BADGER, offeredLocation: '/work' }]);
    renderComposerBar();

    const ask = await openTrust(user);
    await user.click(within(ask).getByRole('checkbox', parentBox));
    await user.click(within(ask).getByRole('button', { name: 'Trust folder' }));

    expect(setTrust).toHaveBeenCalledExactlyOnceWith('/work/cloned-repo', 'trusted', '/work');
  });

  it('is absent where the host offers no parent, such as a folder in the home directory', async () => {
    const user = setup();
    seedThread([CLONED]);
    setHost([CLONED]);
    renderComposerBar();

    const ask = await openTrust(user);
    expect(within(ask).queryByRole('checkbox')).not.toBeInTheDocument();
  });
});
