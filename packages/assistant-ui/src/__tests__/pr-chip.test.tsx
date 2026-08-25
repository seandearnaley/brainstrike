import type { ForgePrStatus, ForgePullRequest } from '@brainstrike/types';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PrChip, type WorkspaceBarForge } from '../workspace-bar/pr-chip';

const pullRequest: ForgePullRequest = {
  checks: [
    { conclusion: 'success', name: 'unit', url: 'https://example.test/unit' },
    { conclusion: 'failure', name: 'e2e', url: null },
  ],
  checksRollup: 'failing',
  headSha: 'sha-1',
  isDraft: false,
  number: 2574,
  reviewDecision: 'CHANGES_REQUESTED',
  state: 'open',
  title: 'Add the workspace bar',
  url: 'https://github.com/acme/widgets/pull/2574',
};

function forge(overrides: Partial<WorkspaceBarForge> = {}): WorkspaceBarForge {
  return {
    onAskAgentToFixChecks: vi.fn(),
    onCopyUrl: vi.fn(),
    onOpenExternal: vi.fn(),
    onRefresh: vi.fn(),
    onWatchChange: vi.fn(),
    status: { kind: 'pr', observedAt: '2026-08-24T00:00:00.000Z', pullRequest },
    watched: true,
    ...overrides,
  };
}

describe('PrChip', () => {
  it('renders nothing when gh observed no pull request', () => {
    const { container } = render(
      <PrChip forge={forge({ status: { kind: 'none', observedAt: '2026-08-24T00:00:00.000Z' } })} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when PR status is unavailable — the BranchChip explains it', () => {
    const status: ForgePrStatus = {
      failure: { detail: 'GitHub CLI (gh) was not found on PATH.', reason: 'gh-missing' },
      kind: 'unavailable',
    };
    const { container } = render(<PrChip forge={forge({ status })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when no observation has happened yet', () => {
    const { container } = render(<PrChip forge={forge({ status: { kind: 'unknown' } })} />);
    expect(container).toBeEmptyDOMElement();
  });

  // BST-1391 fix round (L1): a stale observation with no last-known pull
  // request has nothing to render — the same "nothing" as `unavailable`, not
  // a crash on a null `pullRequest`. The BranchChip's forge diagnostic is
  // this status's only home (see `use-thread-forge-pr.ts` F2).
  it('renders nothing for a stale observation with no last-known pull request', () => {
    const status: ForgePrStatus = {
      failure: { detail: 'gh-unauthenticated: run `gh auth login`.', reason: 'gh-unauthenticated' },
      kind: 'stale',
      observedAt: '2026-08-24T00:00:00.000Z',
      pullRequest: null,
    };
    const { container } = render(<PrChip forge={forge({ status })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the number and the failing rollup', () => {
    render(<PrChip forge={forge()} />);
    const chip = screen.getByTestId('workspace-bar-pr-chip');
    expect(chip).toHaveTextContent('#2574');
    expect(chip).toHaveTextContent('1 failing');
    expect(chip).toHaveAttribute('data-checks', 'failing');
    expect(chip).toHaveAttribute('data-stale', 'false');
  });

  it('shows a passing count as n/n', () => {
    const passing: ForgePullRequest = {
      ...pullRequest,
      checks: [
        { conclusion: 'success', name: 'a', url: null },
        { conclusion: 'success', name: 'b', url: null },
      ],
      checksRollup: 'passing',
    };
    render(
      <PrChip
        forge={forge({
          status: { kind: 'pr', observedAt: '2026-08-24T00:00:00.000Z', pullRequest: passing },
        })}
      />
    );
    expect(screen.getByTestId('workspace-bar-pr-chip')).toHaveTextContent('2/2');
  });

  it('labels a draft and a merged pull request by state, not by checks', () => {
    render(
      <PrChip
        forge={forge({
          status: {
            kind: 'pr',
            observedAt: '2026-08-24T00:00:00.000Z',
            pullRequest: { ...pullRequest, isDraft: true },
          },
        })}
      />
    );
    expect(screen.getByTestId('workspace-bar-pr-chip')).toHaveTextContent('draft');
  });

  it('marks a stale observation and shows the failure in the popover', async () => {
    const user = userEvent.setup();
    render(
      <PrChip
        forge={forge({
          status: {
            failure: { detail: 'HTTP 503: upstream unavailable', reason: 'fetch-failed' },
            kind: 'stale',
            observedAt: '2026-08-24T00:00:00.000Z',
            pullRequest,
          },
        })}
      />
    );
    const chip = screen.getByTestId('workspace-bar-pr-chip');
    expect(chip).toHaveAttribute('data-stale', 'true');
    await user.click(chip);
    expect(await screen.findByTestId('workspace-bar-pr-error')).toHaveTextContent(
      'HTTP 503: upstream unavailable'
    );
  });

  it('lists every check in the popover with its status', async () => {
    const user = userEvent.setup();
    render(<PrChip forge={forge()} />);
    await user.click(screen.getByTestId('workspace-bar-pr-chip'));
    expect(await screen.findByTestId('workspace-bar-pr-check-unit')).toHaveTextContent('unit');
    expect(screen.getByTestId('workspace-bar-pr-check-e2e')).toHaveTextContent('e2e');
  });

  // BST-1391 fix round (F3): duplicate check names are real — matrix jobs and
  // cross-workflow checks can share a name — so `key={check.name}` alone
  // collided. Both rows must render.
  it('renders every row even when two checks share a name (matrix jobs)', async () => {
    const user = userEvent.setup();
    const duplicateNamed: ForgePullRequest = {
      ...pullRequest,
      checks: [
        { conclusion: 'success', name: 'build (18.x)', url: null },
        { conclusion: 'failure', name: 'build (18.x)', url: null },
      ],
    };
    render(
      <PrChip
        forge={forge({
          status: {
            kind: 'pr',
            observedAt: '2026-08-24T00:00:00.000Z',
            pullRequest: duplicateNamed,
          },
        })}
      />
    );
    await user.click(screen.getByTestId('workspace-bar-pr-chip'));
    expect(await screen.findAllByTestId('workspace-bar-pr-check-build (18.x)')).toHaveLength(2);
  });

  it('wires open, copy, refresh and watch', async () => {
    const user = userEvent.setup();
    const props = forge();
    render(<PrChip forge={props} />);
    await user.click(screen.getByTestId('workspace-bar-pr-chip'));
    await user.click(await screen.findByTestId('workspace-bar-pr-open-external'));
    expect(props.onOpenExternal).toHaveBeenCalledWith(pullRequest.url);

    await user.click(screen.getByTestId('workspace-bar-pr-chip'));
    await user.click(await screen.findByTestId('workspace-bar-pr-copy-url'));
    expect(props.onCopyUrl).toHaveBeenCalledWith(pullRequest.url);

    await user.click(screen.getByTestId('workspace-bar-pr-chip'));
    await user.click(await screen.findByTestId('workspace-bar-pr-refresh'));
    expect(props.onRefresh).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId('workspace-bar-pr-chip'));
    await user.click(await screen.findByTestId('workspace-bar-pr-watch'));
    expect(props.onWatchChange).toHaveBeenCalledWith(false);
  });

  it('offers the fix-checks prompt only when checks are failing and a handler exists', async () => {
    const user = userEvent.setup();
    const props = forge();
    render(<PrChip forge={props} />);
    await user.click(screen.getByTestId('workspace-bar-pr-chip'));
    await user.click(await screen.findByTestId('workspace-bar-pr-fix-checks'));
    expect(props.onAskAgentToFixChecks).toHaveBeenCalledTimes(1);
  });

  // BST-1391 fix round (L4): no thread to persist the toggle against means
  // the Watch item is HIDDEN, not offered as an action that can only fail.
  it('hides the Watch item when there is no thread to persist it against', async () => {
    const user = userEvent.setup();
    render(<PrChip forge={forge({ onWatchChange: undefined })} />);
    await user.click(screen.getByTestId('workspace-bar-pr-chip'));
    await screen.findByTestId('workspace-bar-pr-refresh');
    expect(screen.queryByTestId('workspace-bar-pr-watch')).toBeNull();
  });

  it('hides the fix-checks prompt when checks are passing', async () => {
    const user = userEvent.setup();
    render(
      <PrChip
        forge={forge({
          status: {
            kind: 'pr',
            observedAt: '2026-08-24T00:00:00.000Z',
            pullRequest: { ...pullRequest, checks: [], checksRollup: 'none' },
          },
        })}
      />
    );
    await user.click(screen.getByTestId('workspace-bar-pr-chip'));
    expect(screen.queryByTestId('workspace-bar-pr-fix-checks')).toBeNull();
  });
});
