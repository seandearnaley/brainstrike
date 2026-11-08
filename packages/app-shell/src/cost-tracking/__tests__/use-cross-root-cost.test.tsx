import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCrossRootCost } from '../use-cross-root-cost';

type AgentHostBridge = { connect: (requestId: string) => Promise<void> } | undefined;

function setDesktopAgentHost(bridge: AgentHostBridge): void {
  (window as unknown as { agentHost?: AgentHostBridge }).agentHost = bridge;
}

function installCatalog(readRoots: () => Promise<unknown>): void {
  Object.defineProperty(window, 'threadGroups', {
    configurable: true,
    value: { readRoots: async () => ({ ok: true, value: await readRoots() }) },
  });
}

describe('useCrossRootCost', () => {
  beforeEach(() => {
    // Default: durable assistant backend present (desktop) unless a test clears it.
    setDesktopAgentHost({ connect: async () => undefined });
  });

  afterEach(() => {
    setDesktopAgentHost(undefined);
    Reflect.deleteProperty(window, 'threadGroups');
    vi.restoreAllMocks();
  });

  it('is unavailable without a durable assistant backend', async () => {
    setDesktopAgentHost(undefined);
    installCatalog(async () => []);
    const { result } = renderHook(() => useCrossRootCost());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.available).toBe(false);
    expect(result.current.rows).toEqual([]);
  });

  it('names a host row by its root, keeping the committed name for an unnamed root', async () => {
    installCatalog(async () => [
      { displayName: 'Workspace B', id: 'root-b', path: '/fixture/b' },
      { displayName: null, id: 'root-c', path: '/fixture/c' },
    ]);
    const hostRow = {
      checkoutBranch: null,
      estimatedCostUsd: 0,
      estimatedInputTokens: 40,
      estimatedOutputTokens: 6,
      inputTokens: 40,
      localRootId: null,
      model: 'anthropic/claude-sonnet-4.6',
      outputTokens: 6,
      provider: 'openrouter',
    };
    const hostRootUsage = [
      { ...hostRow, rootDisplayName: null, rootId: null },
      { ...hostRow, rootDisplayName: null, rootId: 'root-b' },
      { ...hostRow, rootDisplayName: 'Committed name', rootId: 'root-c' },
    ];

    const { result } = renderHook(() => useCrossRootCost(hostRootUsage));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(
      result.current.rows.map(({ rootDisplayName, rootId }) => [rootId, rootDisplayName])
    ).toEqual([
      [null, null],
      ['root-b', 'Workspace B'],
      // A root the table leaves unnamed keeps the name its run committed.
      ['root-c', 'Committed name'],
    ]);
  });

  it('names a worktree row after its repository rather than its generated directory', async () => {
    installCatalog(async () => [
      { displayName: 'Brainstrike', id: 'root-main', path: '/fixture/main' },
      { displayName: 'x7f3', id: 'root-wt', path: '/fixture/.worktrees/x7f3' },
    ]);
    const usage = [
      {
        checkoutBranch: 'cost/ledger-redesign',
        estimatedCostUsd: 0.01,
        estimatedInputTokens: 40,
        estimatedOutputTokens: 6,
        inputTokens: 40,
        localRootId: 'root-main',
        model: 'model',
        outputTokens: 6,
        provider: 'provider',
        rootDisplayName: 'x7f3',
        rootId: 'root-wt',
      },
    ];
    const { result } = renderHook(() => useCrossRootCost(usage));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rows[0]).toMatchObject({
      checkoutBranch: 'cost/ledger-redesign',
      rootDisplayName: 'Brainstrike',
    });
  });

  it('reads native folder names and surfaces catalog failure', async () => {
    const readRoots = vi
      .fn()
      .mockResolvedValue([{ displayName: 'Current folder', id: 'root-b', path: '/fixture' }]);
    installCatalog(readRoots);
    const usage = [
      {
        checkoutBranch: null,
        estimatedCostUsd: 0,
        estimatedInputTokens: 40,
        estimatedOutputTokens: 6,
        inputTokens: 40,
        localRootId: null,
        model: 'model',
        outputTokens: 6,
        provider: 'provider',
        rootDisplayName: 'Committed folder',
        rootId: 'root-b',
      },
    ];
    const { result, unmount } = renderHook(() => useCrossRootCost(usage));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rows[0]?.rootDisplayName).toBe('Current folder');
    unmount();
    const failure = new Error('Catalog unavailable');
    readRoots.mockRejectedValue(failure);
    const failed = renderHook(() => useCrossRootCost(usage));
    await waitFor(() =>
      expect(failed.result.current.error).toMatchObject({ cause: failure, failure: INTERNAL_FAULT })
    );
  });
});
