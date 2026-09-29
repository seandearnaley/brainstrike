import {
  type AssistantMemoryThread,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import { createTestActionRegistry } from '@brainstrike/context-actions';
import type { ForgePrCacheEntry } from '@brainstrike/types';
import { ActionRegistryProvider } from '@brainstrike/ui';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ThreadBranchInfo } from '../hooks/use-thread-branch-by-root-path';
import { ThreadRow, type ThreadRowProps } from '../thread-row';
import { ThreadMetadataBadges } from '../thread-row-metadata';

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
    branch: null,
    draggable: false,
    groupId: null,
    moveTargets: [],
    onDeleteThread: vi.fn().mockResolvedValue(undefined),
    onMoveThreadToGroup: vi.fn().mockResolvedValue(undefined),
    onRenameThread: vi.fn().mockResolvedValue(undefined),
    onSelectThread: vi.fn(),
    onUpdateThreadMetadata: vi.fn().mockResolvedValue(undefined),
    pr: null,
    selected: false,
    status: null,
    thread: THREAD,
    ...overrides,
  };
}

describe('thread row PR pill', () => {
  const thread: AssistantMemoryThread = {
    createdAt: new Date('2026-08-24T00:00:00Z'),
    id: 'thread-pr-pill',
    resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
    title: 'PR pill thread',
    updatedAt: new Date('2026-08-24T01:00:00Z'),
  };
  const pr: ForgePrCacheEntry = {
    branch: 'main',
    checksRollup: 'failing',
    isDraft: false,
    number: 2574,
    repoCommonDir: '/repos/widgets/.git',
    state: 'open',
    url: 'https://github.test/acme/widgets/pull/2574',
  };

  it('renders the PR number and open failing state', () => {
    render(<ThreadMetadataBadges branch={null} pr={pr} thread={thread} />);

    const pill = screen.getByTestId('thread-pr-pill');
    expect(pill).toHaveTextContent('#2574');
    expect(pill).toHaveAttribute('data-checks', 'failing');
    expect(pill).toHaveAttribute('data-state', 'open');
  });

  it('renders no PR pill when there is no cached PR', () => {
    render(<ThreadMetadataBadges branch={null} pr={null} thread={thread} />);

    expect(screen.queryByTestId('thread-pr-pill')).toBeNull();
  });

  it('marks merged PRs for faded row styling', () => {
    render(<ThreadMetadataBadges branch={null} pr={{ ...pr, state: 'merged' }} thread={thread} />);

    expect(screen.getByTestId('thread-pr-pill')).toHaveAttribute('data-state', 'merged');
  });

  describe('provider badge — the wideOnly "protected slot" it can inherit', () => {
    const branchInfo: ThreadBranchInfo = {
      branch: 'main',
      detached: false,
      gitCommonDir: '/repos/widgets/.git',
    };
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

    // (a) No branch and no PR: provider is the row's first badge, so it takes
    // over the "always visible in the narrow band" slot instead of also
    // hiding until 560px.
    it('does not wide-gate the provider badge when nothing protected renders', () => {
      render(<ThreadMetadataBadges branch={null} pr={null} thread={threadWithProvider} />);

      const className = providerBadgeClassName();
      expect(className).toContain('inline-flex');
      expect(className).not.toContain('hidden');
      expect(className).not.toContain('@[560px]/threads:inline-flex');
    });

    // (b) Branch present: branch occupies the protected slot, so provider
    // reverts to hiding until 560px, same as model/reasoning/max-output.
    it('wide-gates the provider badge once a branch renders, and keeps the branch visible', () => {
      render(<ThreadMetadataBadges branch={branchInfo} pr={null} thread={threadWithProvider} />);

      const providerClassName = providerBadgeClassName();
      expect(providerClassName).toContain('hidden');
      expect(providerClassName).toContain('@[560px]/threads:inline-flex');

      const branchClassName = screen.getByText('main').className;
      expect(branchClassName).toContain('inline-flex');
      expect(branchClassName).not.toContain('hidden');
    });

    // (c) PR present (no branch): the PR pill alone is enough to occupy the
    // protected slot too.
    it('wide-gates the provider badge once a PR pill renders', () => {
      render(<ThreadMetadataBadges branch={null} pr={pr} thread={threadWithProvider} />);

      const providerClassName = providerBadgeClassName();
      expect(providerClassName).toContain('hidden');
      expect(providerClassName).toContain('@[560px]/threads:inline-flex');
      expect(screen.getByTestId('thread-pr-pill')).toBeVisible();
    });
  });
});

function renderRow(props: ThreadRowProps) {
  const actionRegistry = createTestActionRegistry();
  const renderResult = render(
    <ActionRegistryProvider registry={actionRegistry.registry}>
      <ThreadRow {...props} />
    </ActionRegistryProvider>
  );
  return { actionRegistry, ...renderResult };
}

describe('ThreadRow', () => {
  it('owns a rename draft across parent rerenders and submits the explicit row action', async () => {
    const user = userEvent.setup();
    const onRenameThread = vi.fn().mockResolvedValue(undefined);
    const props = createProps({ onRenameThread });
    const { actionRegistry, rerender } = renderRow(props);

    await user.click(screen.getByRole('button', { name: 'Thread actions Review architecture' }));
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Thread title' });
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, 'Keep this draft');

    rerender(
      <ActionRegistryProvider registry={actionRegistry.registry}>
        <ThreadRow {...props} selected />
      </ActionRegistryProvider>
    );

    expect(screen.getByRole('textbox', { name: 'Thread title' })).toHaveValue('Keep this draft');
    await user.click(screen.getByRole('button', { name: 'Save thread title' }));
    await waitFor(() => {
      expect(onRenameThread).toHaveBeenCalledWith(THREAD.id, 'Keep this draft');
    });
  });

  it('keeps customization persistence and errors local to the row', async () => {
    const user = userEvent.setup();
    const onUpdateThreadMetadata = vi.fn().mockRejectedValue(new Error('Metadata write failed.'));
    renderRow(createProps({ onUpdateThreadMetadata }));

    await user.click(screen.getByRole('button', { name: 'Thread actions Review architecture' }));
    await user.click(screen.getByRole('button', { name: 'Customize' }));
    const customizer = screen.getByRole('dialog');
    await user.click(within(customizer).getByRole('button', { name: 'Use Bug icon' }));

    expect(await screen.findByText('Metadata write failed.')).toBeVisible();
    expect(onUpdateThreadMetadata).toHaveBeenCalledWith(THREAD.id, { icon: 'bug' });
    expect(screen.getByTestId('thread-row')).toBeVisible();
  });

  it('offers curated color sets and persists a chosen Voltage color', async () => {
    const user = userEvent.setup();
    const onUpdateThreadMetadata = vi.fn().mockResolvedValue(undefined);
    renderRow(createProps({ onUpdateThreadMetadata }));

    await user.click(screen.getByRole('button', { name: 'Thread actions Review architecture' }));
    await user.click(screen.getByRole('button', { name: 'Customize' }));
    const customizer = screen.getByRole('dialog');
    expect(within(customizer).getByTestId('thread-color-palette-studio')).toBeVisible();
    expect(within(customizer).getByTestId('thread-color-palette-voltage')).toBeVisible();
    expect(within(customizer).getByTestId('thread-color-palette-afterglow')).toBeVisible();
    expect(within(customizer).getByTestId('thread-color-family-preview')).toBeVisible();
    await user.click(within(customizer).getByRole('button', { name: 'Use Cyan color' }));

    expect(onUpdateThreadMetadata).toHaveBeenCalledWith(THREAD.id, { color: 'cyan' });
  });

  it('refreshes saved agent colors from root customization and shows the result', async () => {
    const user = userEvent.setup();
    const onRefreshAgentColors = vi.fn().mockResolvedValue(3);
    renderRow(createProps({ onRefreshAgentColors }));

    await user.click(screen.getByRole('button', { name: 'Thread actions Review architecture' }));
    await user.click(screen.getByRole('button', { name: 'Customize' }));
    await user.click(screen.getByRole('button', { name: 'Refresh agent colors' }));

    expect(onRefreshAgentColors).toHaveBeenCalledWith(THREAD.id, THREAD.resourceId);
    expect(await screen.findByText('Refreshed 3 saved agent colors.')).toBeVisible();
  });

  it('shows a failed agent color refresh in the customization panel', async () => {
    const user = userEvent.setup();
    const onRefreshAgentColors = vi.fn().mockRejectedValue(new Error('Finish the active run.'));
    renderRow(createProps({ onRefreshAgentColors }));

    await user.click(screen.getByRole('button', { name: 'Thread actions Review architecture' }));
    await user.click(screen.getByRole('button', { name: 'Customize' }));
    await user.click(screen.getByRole('button', { name: 'Refresh agent colors' }));

    expect(await screen.findByText('Finish the active run.')).toBeVisible();
  });

  it('keeps delete confirmation and failures local to the row', async () => {
    const user = userEvent.setup();
    const onDeleteThread = vi.fn().mockRejectedValue(new Error('Delete failed.'));
    renderRow(createProps({ onDeleteThread }));

    await user.click(screen.getByRole('button', { name: 'Thread actions Review architecture' }));
    await user.click(screen.getByRole('button', { name: 'Delete…' }));
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
    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    expect(
      screen.getByRole('button', { name: 'Confirm delete thread Review architecture' })
    ).toBeVisible();

    rerender(
      <ActionRegistryProvider registry={actionRegistry.registry}>
        <ThreadRow {...createProps({ thread: secondThread })} key={secondThread.id} />
      </ActionRegistryProvider>
    );

    expect(screen.getByText('Replacement thread')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Confirm delete thread/ })).toBeNull();
  });
});
