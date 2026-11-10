import {
  type AssistantMemoryThread,
  AssistantThreadAppearanceSaveError,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import { createTestActionRegistry } from '@brainstrike/context-actions';
import { ActionRegistryProvider, TooltipProvider, toast } from '@brainstrike/ui';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThreadRow, type ThreadRowProps } from '../thread-row';
import { ThreadMetadataBadges } from '../thread-row-metadata';

vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  toast: vi.fn(),
}));
afterEach(() => {
  vi.mocked(toast).mockClear();
});

const THREAD: AssistantMemoryThread = {
  createdAt: new Date('2026-09-18T10:00:00Z'),
  id: 'thread-row-test',
  metadata: { color: 'blue', icon: 'message' },
  resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
  title: 'Review architecture',
  updatedAt: new Date('2026-09-18T11:00:00Z'),
};

function createProps(overrides: Partial<ThreadRowProps> = {}): ThreadRowProps {
  return {
    draggable: false,
    groupId: null,
    moveTargets: [],
    onDeleteThread: vi.fn().mockResolvedValue(undefined),
    onMoveThreadToGroup: vi.fn().mockResolvedValue(undefined),
    onRenameThread: vi.fn().mockResolvedValue(undefined),
    onSelectThread: vi.fn(),
    onSetThreadPinned: null,
    onUpdateThreadAppearance: vi.fn().mockResolvedValue(undefined),
    pinned: false,
    selected: false,
    status: null,
    thread: THREAD,
    ...overrides,
  };
}

describe('thread metadata badges', () => {
  const thread: AssistantMemoryThread = {
    createdAt: new Date('2026-08-24T00:00:00Z'),
    id: 'thread-badges',
    resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
    title: 'Badges thread',
    updatedAt: new Date('2026-08-24T01:00:00Z'),
  };

  const inFolder: AssistantMemoryThread['metadata'] = {
    operatingRootDisplayName: 'widgets',
    operatingRootId: 'root-widgets',
    operatingRootPath: '/repos/widgets',
  };
  const inWorktree: AssistantMemoryThread['metadata'] = {
    checkoutBranch: 'swift-badger',
    checkoutLocalRootId: 'root-widgets',
    checkoutMode: 'worktree',
    checkoutWorktreeId: 'worktree-1',
    checkoutWorktreePath: '/worktrees/widgets/swift-badger',
    operatingRootDisplayName: 'swift-badger',
    operatingRootId: 'root-worktree',
    operatingRootPath: '/worktrees/widgets/swift-badger',
  };

  describe('checkout chip: where the thread works', () => {
    it('says Local for a thread that works in its folder itself', () => {
      render(<ThreadMetadataBadges thread={{ ...thread, metadata: inFolder }} />);

      expect(screen.getByTestId('thread-checkout-chip')).toHaveTextContent('Local');
    });

    it('names the worktree for a thread that works in one', () => {
      render(<ThreadMetadataBadges thread={{ ...thread, metadata: inWorktree }} />);

      const chip = screen.getByTestId('thread-checkout-chip');
      expect(chip).toHaveTextContent('swift-badger');
      // The name alone can repeat across repositories; the path tells them apart.
      expect(chip).toHaveAttribute(
        'title',
        'Worktree swift-badger at /worktrees/widgets/swift-badger'
      );
    });

    it('shows nothing for a thread with no folder', () => {
      const { container } = render(<ThreadMetadataBadges thread={thread} />);

      expect(container).toBeEmptyDOMElement();
    });

    // jsdom evaluates no container query, so these two pin the width gates by
    // class; the desktop spec checks the painted chips in a wide panel.
    it('keeps a worktree marked at every panel width, and names it once there is room', () => {
      render(<ThreadMetadataBadges thread={{ ...thread, metadata: inWorktree }} />);

      // The pill itself is never gated: under 420px it is the branch icon alone,
      // so a narrow panel still tells a worktree thread from a Local one.
      const chip = screen.getByTestId('thread-checkout-chip');
      expect(chip.className.split(' ')).not.toContain('hidden');
      expect(chip.closest('[data-testid="thread-metadata-badges"]')).toBeNull();
      // Its name waits for 420px, where it no longer starves the title; until
      // then hovering the icon gives it.
      expect(chip).toHaveAttribute('title', expect.stringContaining('swift-badger'));
      expect(screen.getByText('swift-badger').className).toContain('@[420px]/threads:inline');
    });

    it('leaves a narrow panel to the title for a Local thread', () => {
      render(<ThreadMetadataBadges thread={{ ...thread, metadata: inFolder }} />);

      // Local is the unmarked case, so its chip is the one that gives way.
      expect(screen.getByTestId('thread-checkout-chip').className).toContain(
        'hidden @[420px]/threads:inline-flex'
      );
    });
  });

  describe('provider badge — the "protected slot" it can inherit', () => {
    const threadWithProvider: AssistantMemoryThread = {
      ...thread,
      latestRun: {
        completedAt: new Date('2026-08-24T00:05:00Z'),
        createdAt: new Date('2026-08-24T00:00:00Z'),
        error: null,
        id: 'run-1',
        model: 'claude-sonnet-5',
        provider: 'openrouter',
        resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
        runtimeKind: 'hosted',
        startedAt: new Date('2026-08-24T00:00:00Z'),
        status: 'completed',
        threadId: thread.id,
        turnMessageId: null,
        updatedAt: new Date('2026-08-24T00:05:00Z'),
      },
    };

    function providerBadgeClassName(): string {
      return screen.getByText('OpenRouter').className;
    }

    // (a) No checkout chip: provider is the row's first badge, so it shows
    // from the narrow band instead of also hiding until 560px.
    it('does not wide-gate the provider badge when no checkout chip renders', () => {
      render(<ThreadMetadataBadges thread={threadWithProvider} />);

      const className = providerBadgeClassName();
      expect(className).toContain('inline-flex');
      expect(className).not.toContain('hidden');
      expect(className).not.toContain('@[560px]/threads:inline-flex');
    });

    // (b) Checkout chip present: it holds the row's first slot, so provider
    // hides until 560px, same as model/reasoning/max-output.
    it('wide-gates the provider badge once a checkout chip renders', () => {
      render(<ThreadMetadataBadges thread={{ ...threadWithProvider, metadata: inFolder }} />);

      const providerClassName = providerBadgeClassName();
      expect(providerClassName).toContain('hidden');
      expect(providerClassName).toContain('@[560px]/threads:inline-flex');
    });
  });
});

function renderRow(props: ThreadRowProps) {
  const actionRegistry = createTestActionRegistry();
  // The app shell's TooltipProvider wraps every row.
  const renderResult = render(<ThreadRow {...props} />, {
    wrapper: ({ children }) => (
      <TooltipProvider>
        <ActionRegistryProvider registry={actionRegistry.registry}>
          {children}
        </ActionRegistryProvider>
      </TooltipProvider>
    ),
  });
  return { actionRegistry, ...renderResult };
}

describe('ThreadRow', () => {
  it.each([
    { name: 'Review architecture', status: null },
    { name: 'Review architecture is active', status: 'running' },
    { name: 'Review architecture needs your approval', status: 'needs-you' },
    { name: 'Review architecture failed', status: 'failed-unseen' },
    { name: 'Review architecture has unseen activity', status: 'done-unseen' },
  ] as const)(
    'announces the title once with $status status and still opens its thread',
    async ({ name, status }) => {
      const props = createProps({ status });
      renderRow(props);
      const open = screen.getByRole('button', { name });
      expect(open).toHaveAccessibleName(name);
      if (status) {
        expect(within(open).getByRole('img', { name })).toBeVisible();
      }
      await userEvent.setup().click(open);
      expect(props.onSelectThread).toHaveBeenCalledExactlyOnceWith(THREAD.id);
    }
  );

  it('marks a thread whose history cannot be read, with the reason on focus', async () => {
    const reason = 'thread thread-row-test is damaged at seq 2: row crc mismatch';
    renderRow(createProps({ thread: { ...THREAD, readFailure: reason } }));
    const marker = screen.getByRole('button', {
      name: `Review architecture: its history cannot be read. ${reason}`,
    });
    marker.focus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent(reason);
  });

  it('marks nothing on a thread whose history reads', () => {
    renderRow(createProps());
    expect(screen.queryByTestId('thread-read-failure')).toBeNull();
  });

  it('owns a rename draft across parent rerenders and submits the explicit row action', async () => {
    const user = userEvent.setup();
    const onRenameThread = vi.fn().mockResolvedValue(undefined);
    const props = createProps({ onRenameThread });
    const { rerender } = renderRow(props);

    await user.click(screen.getByRole('button', { name: 'Thread actions Review architecture' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Thread title' });
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, 'Keep this draft');

    rerender(<ThreadRow {...props} selected />);

    expect(screen.getByRole('textbox', { name: 'Thread title' })).toHaveValue('Keep this draft');
    await user.click(screen.getByRole('button', { name: 'Save thread title' }));
    await waitFor(() => {
      expect(onRenameThread).toHaveBeenCalledWith(THREAD.id, 'Keep this draft');
    });
  });

  it('offers the thread actions as a menu that arrow keys and type-ahead move through', async () => {
    const user = userEvent.setup();
    const onRenameThread = vi.fn().mockResolvedValue(undefined);
    renderRow(
      createProps({ onRenameThread, onSetThreadPinned: vi.fn().mockResolvedValue(undefined) })
    );

    screen.getByRole('button', { name: 'Thread actions Review architecture' }).focus();
    await user.keyboard('{Enter}');
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
    ).toEqual(['Customize', 'Pin', 'Rename', 'Delete…']);
    expect(within(menu).getByRole('menuitem', { name: 'Customize' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(within(menu).getByRole('menuitem', { name: 'Pin' })).toHaveFocus();
    await user.keyboard('r');
    expect(within(menu).getByRole('menuitem', { name: 'Rename' })).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Thread title' })).toHaveFocus();
  });

  it('opens Customize as a panel that Escape closes back to the actions button', async () => {
    const user = userEvent.setup();
    renderRow(createProps());
    const actions = screen.getByRole('button', { name: 'Thread actions Review architecture' });

    await user.click(actions);
    await user.click(screen.getByRole('menuitem', { name: 'Customize' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(within(screen.getByRole('dialog')).getByText('Thread appearance')).toBeVisible();

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(actions).toHaveFocus();
    });

    // Pressing "…" again while the panel is open closes it rather than opening the menu.
    await user.click(actions);
    await user.click(screen.getByRole('menuitem', { name: 'Customize' }));
    expect(screen.getByRole('dialog')).toBeVisible();
    await user.click(actions);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(screen.queryByRole('menu')).toBeNull();

    // So does Enter on a focused "…".
    await user.click(actions);
    await user.click(screen.getByRole('menuitem', { name: 'Customize' }));
    expect(screen.getByRole('dialog')).toBeVisible();
    actions.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  // BST-2116: a pick shows at once; a save that fails and is put back says so,
  // in the row and in a toast (the panel may already be closed).
  it('says a failed customization was changed back, in the row and a toast', async () => {
    const user = userEvent.setup();
    const onUpdateThreadAppearance = vi
      .fn()
      .mockRejectedValue(
        new AssistantThreadAppearanceSaveError(true, new Error('Metadata write failed.'))
      );
    renderRow(createProps({ onUpdateThreadAppearance }));

    await user.click(screen.getByRole('button', { name: 'Thread actions Review architecture' }));
    await user.click(screen.getByRole('menuitem', { name: 'Customize' }));
    const customizer = screen.getByRole('dialog');
    await user.click(within(customizer).getByRole('button', { name: 'Use Bug icon' }));

    expect(
      await screen.findByText(
        'The thread icon was not saved, so it was changed back: Metadata write failed.'
      )
    ).toBeVisible();
    expect(toast).toHaveBeenCalledWith({
      description: 'It was changed back. Metadata write failed.',
      title: 'Couldn’t save the thread icon',
      variant: 'destructive',
    });
    expect(onUpdateThreadAppearance).toHaveBeenCalledWith(THREAD.id, { icon: 'bug' });
    expect(screen.getByTestId('thread-row')).toBeVisible();
  });

  it('keeps the swatches live while a save is in flight, and says nothing when a newer pick decides', async () => {
    const user = userEvent.setup();
    const onUpdateThreadAppearance = vi
      .fn()
      .mockReturnValueOnce(new Promise(() => undefined))
      .mockRejectedValueOnce(new AssistantThreadAppearanceSaveError(false, new Error('lost')));
    renderRow(createProps({ onUpdateThreadAppearance }));

    await user.click(screen.getByRole('button', { name: 'Thread actions Review architecture' }));
    await user.click(screen.getByRole('menuitem', { name: 'Customize' }));
    const customizer = screen.getByRole('dialog');
    await user.click(within(customizer).getByRole('button', { name: 'Use Bug icon' }));
    const cyan = within(customizer).getByRole('button', { name: 'Use Cyan color' });
    expect(cyan).toBeEnabled();
    await user.click(cyan);

    expect(onUpdateThreadAppearance).toHaveBeenNthCalledWith(2, THREAD.id, { color: 'cyan' });
    await waitFor(() => {
      expect(onUpdateThreadAppearance).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByText(/was not saved/u)).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });

  it('offers curated color sets and persists a chosen Voltage color', async () => {
    const user = userEvent.setup();
    const onUpdateThreadAppearance = vi.fn().mockResolvedValue(undefined);
    renderRow(createProps({ onUpdateThreadAppearance }));

    await user.click(screen.getByRole('button', { name: 'Thread actions Review architecture' }));
    await user.click(screen.getByRole('menuitem', { name: 'Customize' }));
    const customizer = screen.getByRole('dialog');
    expect(within(customizer).getByTestId('thread-color-palette-studio')).toBeVisible();
    expect(within(customizer).getByTestId('thread-color-palette-voltage')).toBeVisible();
    expect(within(customizer).getByTestId('thread-color-palette-afterglow')).toBeVisible();
    expect(within(customizer).getByTestId('thread-color-family-preview')).toBeVisible();
    await user.click(within(customizer).getByRole('button', { name: 'Use Cyan color' }));

    expect(onUpdateThreadAppearance).toHaveBeenCalledWith(THREAD.id, { color: 'cyan' });
  });

  it('keeps delete confirmation and failures local to the row', async () => {
    const user = userEvent.setup();
    const onDeleteThread = vi.fn().mockRejectedValue(new Error('Delete failed.'));
    renderRow(createProps({ onDeleteThread }));

    await user.click(screen.getByRole('button', { name: 'Thread actions Review architecture' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }));
    await user.click(
      screen.getByRole('button', { name: 'Confirm delete thread Review architecture' })
    );

    expect(await screen.findByText('Delete failed.')).toBeVisible();
    expect(onDeleteThread).toHaveBeenCalledWith(THREAD.id);
    expect(screen.getByTestId('thread-row')).toBeVisible();
  });

  it('drops destructive row state when a keyed virtual cell changes thread identity', async () => {
    const user = userEvent.setup();
    const actionRegistry = createTestActionRegistry();
    const firstProps = createProps();
    const secondThread: AssistantMemoryThread = {
      ...THREAD,
      id: 'replacement-thread',
      title: 'Replacement thread',
    };
    const { rerender } = render(
      <ActionRegistryProvider registry={actionRegistry.registry}>
        <ThreadRow {...firstProps} key={THREAD.id} />
      </ActionRegistryProvider>
    );

    await user.click(screen.getByRole('button', { name: 'Thread actions Review architecture' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }));
    expect(
      screen.getByRole('button', { name: 'Confirm delete thread Review architecture' })
    ).toBeVisible();

    rerender(
      <ActionRegistryProvider registry={actionRegistry.registry}>
        <ThreadRow {...createProps({ thread: secondThread })} key={secondThread.id} />
      </ActionRegistryProvider>
    );

    expect(screen.getByText('Replacement thread')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Confirm delete thread/u })).toBeNull();
  });
});
