/**
 * ADR-0034 build decisions: the where-control offers "Turn into a project…"
 * while the thread works in a scratch folder the host made for it. Like every
 * checkout change it waits for the thread's run to end, and it shows why the
 * last one was refused.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  WorkspaceBar,
  type WorkspaceBarProps,
  type WorkspaceBarScratchProject,
} from '../workspace-bar/workspace-bar';

const setup = () => userEvent.setup({ pointerEventsCheck: 0 });

const quietOtter = {
  displayName: 'quiet-otter',
  path: '/userData/scratch/quiet-otter',
  rootId: 'r-scratch',
} as const;

function props(overrides: Partial<WorkspaceBarProps> = {}): WorkspaceBarProps {
  return {
    onAddFolder: vi.fn(),
    onAddWorkspaceFolder: vi.fn(),
    onMakePrimary: vi.fn(),
    onRemovePrimary: vi.fn(),
    onRemoveSecondary: vi.fn(),
    onUseFolder: vi.fn(),
    primaryRoot: quietOtter,
    recentRoots: [],
    secondaryRoots: [],
    threadCheckout: { worktreePath: null },
    workspaceFolders: [],
    ...overrides,
  };
}

function scratchProject(
  overrides: Partial<WorkspaceBarScratchProject> = {}
): WorkspaceBarScratchProject {
  return {
    disabledReason: null,
    onTurnIntoProject: vi.fn(),
    pending: false,
    refusal: null,
    ...overrides,
  };
}

async function openWhere(user: ReturnType<typeof setup>): Promise<void> {
  await user.click(screen.getByTestId('workspace-bar-where-chip'));
  await screen.findByRole('menu');
}

describe('Turn into a project…', () => {
  it('is offered only while the thread works in a scratch folder', async () => {
    const user = setup();
    const { rerender } = render(<WorkspaceBar {...props()} />);
    await openWhere(user);
    expect(screen.queryByTestId('workspace-bar-scratch-project')).toBeNull();

    rerender(<WorkspaceBar {...props({ scratchProject: scratchProject() })} />);
    expect(await screen.findByTestId('workspace-bar-scratch-project')).toHaveTextContent(
      'Turn into a project…'
    );
  });

  it('asks the host to turn the folder into a project', async () => {
    const user = setup();
    const value = scratchProject();
    render(<WorkspaceBar {...props({ scratchProject: value })} />);
    await openWhere(user);
    await user.click(screen.getByTestId('workspace-bar-scratch-project'));
    expect(value.onTurnIntoProject).toHaveBeenCalledTimes(1);
  });

  it("waits for the thread's run to end, saying so", async () => {
    const user = setup();
    const value = scratchProject({ disabledReason: "Available when this thread's run ends." });
    render(<WorkspaceBar {...props({ scratchProject: value })} />);
    await openWhere(user);
    const item = screen.getByTestId('workspace-bar-scratch-project');
    expect(item).toHaveAttribute('data-disabled');
    expect(screen.getByTestId('workspace-bar-scratch-project-disabled-reason')).toHaveTextContent(
      "Available when this thread's run ends."
    );
    await user.click(item);
    expect(value.onTurnIntoProject).not.toHaveBeenCalled();
  });

  it('is busy while the folder moves', async () => {
    const user = setup();
    render(<WorkspaceBar {...props({ scratchProject: scratchProject({ pending: true }) })} />);
    await openWhere(user);
    expect(screen.getByTestId('workspace-bar-scratch-project')).toHaveAttribute('data-disabled');
  });

  it('shows why the last one was refused', async () => {
    const user = setup();
    const refusal =
      '/Users/me/Projects/quiet-otter already exists, so the scratch folder was not moved there.';
    render(<WorkspaceBar {...props({ scratchProject: scratchProject({ refusal }) })} />);
    await openWhere(user);
    expect(screen.getByTestId('workspace-bar-scratch-project-refusal')).toHaveTextContent(refusal);
    expect(screen.getByTestId('workspace-bar-scratch-project')).not.toHaveAttribute(
      'data-disabled'
    );
  });
});
