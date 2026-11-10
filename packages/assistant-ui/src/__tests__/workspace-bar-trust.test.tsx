/**
 * ADR-0032: the composer's workspace trust chip. It says how much of the
 * thread's folders' agent configuration is held back, and opening it asks the
 * one question per answer.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  WorkspaceBar,
  type WorkspaceBarProps,
  type WorkspaceBarTrust,
  type WorkspaceBarTrustAsk,
} from '../workspace-bar/workspace-bar';

const CLONED: WorkspaceBarTrustAsk = {
  displayName: 'cloned-repo',
  folders: [
    {
      displayName: 'cloned-repo',
      holds: 'AGENTS.md, 2 skills, and 1 subagent',
      rootId: 'r-cloned',
    },
  ],
  held: 4,
  path: '/work/cloned-repo',
  sharedWithWorktrees: false,
};

function trust(overrides: Partial<WorkspaceBarTrust> = {}): WorkspaceBarTrust {
  return {
    actionError: null,
    asks: [CLONED],
    busyPath: null,
    onDecide: vi.fn(),
    onRetry: undefined,
    ...overrides,
  };
}

function bar(overrides: Partial<WorkspaceBarProps> = {}): WorkspaceBarProps {
  return {
    onAddFolder: vi.fn(),
    onAddWorkspaceFolder: vi.fn(),
    onMakePrimary: vi.fn(),
    onRemovePrimary: vi.fn(),
    onRemoveSecondary: vi.fn(),
    onUseFolder: vi.fn(),
    primaryRoot: { displayName: 'cloned-repo', path: '/work/cloned-repo', rootId: 'r-cloned' },
    recentRoots: [],
    secondaryRoots: [],
    workspaceFolders: [],
    ...overrides,
  };
}

/** Radix popovers need the pointer-events check off in a headless DOM. */
function setup() {
  return userEvent.setup({ pointerEventsCheck: 0 });
}

async function openTrust(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: /^Workspace trust:/u }));
  return await screen.findByRole('dialog', { name: 'Workspace trust' });
}

describe('WorkspaceBar trust chip', () => {
  it('shows no chip while nothing is held', () => {
    render(<WorkspaceBar {...bar()} />);

    expect(screen.queryByRole('button', { name: /^Workspace trust:/u })).not.toBeInTheDocument();
  });

  it('counts what is held, and asks nothing until it is opened', () => {
    render(<WorkspaceBar {...bar({ trust: trust() })} />);

    expect(screen.getByRole('button', { name: 'Workspace trust: 4 held' })).toHaveTextContent(
      '4 held'
    );
    expect(screen.queryByText('Trust the files in cloned-repo?')).not.toBeInTheDocument();
  });

  it('opens to what trusting the folder would load', async () => {
    const user = setup();
    render(<WorkspaceBar {...bar({ trust: trust() })} />);

    const ask = await openTrust(user);
    expect(ask).toHaveTextContent('Trust the files in cloned-repo?');
    expect(ask).toHaveTextContent('AGENTS.md, 2 skills, and 1 subagent');
  });

  it.each([
    ['Trust folder', 'trusted'],
    ['Keep restricted', 'restricted'],
  ] as const)('"%s" gives the answer for the asked folder', async (label, decision) => {
    const user = setup();
    const onDecide = vi.fn();
    render(<WorkspaceBar {...bar({ trust: trust({ onDecide }) })} />);

    const ask = await openTrust(user);
    await user.click(within(ask).getByRole('button', { name: label }));

    expect(onDecide).toHaveBeenCalledWith(CLONED, decision);
  });

  it('asks once for a repository and names the worktrees the answer covers', async () => {
    const user = setup();
    const repository: WorkspaceBarTrustAsk = {
      displayName: 'brainstrike',
      folders: [
        { displayName: 'swift-badger', holds: 'AGENTS.md and 2 skills', rootId: 'r-badger' },
        { displayName: 'calm-otter', holds: 'AGENTS.md and 3 skills', rootId: 'r-otter' },
      ],
      held: 7,
      path: '/work/brainstrike',
      sharedWithWorktrees: true,
    };
    render(<WorkspaceBar {...bar({ trust: trust({ asks: [repository] }) })} />);

    expect(screen.getByRole('button', { name: 'Workspace trust: 7 held' })).toBeInTheDocument();
    const ask = await openTrust(user);
    expect(within(ask).getAllByRole('button', { name: 'Trust folder' })).toHaveLength(1);
    expect(ask).toHaveTextContent('Trust the files in brainstrike?');
    expect(ask).toHaveTextContent('covers this repository and its worktrees');
    expect(ask).toHaveTextContent('swift-badger: AGENTS.md and 2 skills');
    expect(ask).toHaveTextContent('calm-otter: AGENTS.md and 3 skills');
  });

  it('adds up the folders that each need their own answer', async () => {
    const user = setup();
    const notes: WorkspaceBarTrustAsk = {
      displayName: 'notes',
      folders: [{ displayName: 'notes', holds: 'CLAUDE.md', rootId: 'r-notes' }],
      held: 1,
      path: '/work/notes',
      sharedWithWorktrees: false,
    };
    render(<WorkspaceBar {...bar({ trust: trust({ asks: [CLONED, notes] }) })} />);

    expect(screen.getByRole('button', { name: 'Workspace trust: 5 held' })).toBeInTheDocument();
    const ask = await openTrust(user);
    expect(ask).toHaveTextContent('Trust the files in cloned-repo?');
    expect(ask).toHaveTextContent('Trust the files in notes?');
  });

  it('holds both actions while an answer is being recorded, and shows a refusal', async () => {
    const user = setup();
    render(
      <WorkspaceBar
        {...bar({
          trust: trust({ actionError: 'The agent host is not running', busyPath: CLONED.path }),
        })}
      />
    );

    const ask = await openTrust(user);
    expect(within(ask).getByRole('button', { name: 'Trust folder' })).toBeDisabled();
    expect(within(ask).getByRole('button', { name: 'Keep restricted' })).toBeDisabled();
    expect(within(ask).getByRole('alert')).toHaveTextContent('The agent host is not running');
  });

  it('says when trust could not be checked and offers the retry', async () => {
    const user = setup();
    const onRetry = vi.fn();
    render(<WorkspaceBar {...bar({ trust: trust({ asks: [], onRetry }) })} />);

    expect(
      screen.getByRole('button', { name: 'Workspace trust: not checked' })
    ).toBeInTheDocument();
    const ask = await openTrust(user);
    expect(within(ask).getByRole('alert')).toHaveTextContent(
      'couldn’t check whether this thread’s folders hold instructions or skills'
    );
    await user.click(within(ask).getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
