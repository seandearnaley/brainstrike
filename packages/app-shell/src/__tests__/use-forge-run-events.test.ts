import type { AssistantMemoryThread, AssistantThreadRepository } from '@brainstrike/assistant-data';
import type { ForgePrUpdatedEvent } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useForgeBranchLookupActivation, useForgeRunEvents } from '../hooks/use-forge-run-events';

const COMMON_DIR = '/repos/widgets/.git';

const thread = (overrides: Record<string, unknown> = {}): AssistantMemoryThread =>
  ({
    id: 'thread-1',
    latestRun: { id: 'run-9' },
    metadata: { operatingRootId: 'root-1' },
    title: 'Widget work',
    ...overrides,
  }) as unknown as AssistantMemoryThread;

const branchLookup = {
  byRootId: new Map([
    ['root-1', { branch: 'feature/bar', detached: false, gitCommonDir: COMMON_DIR }],
  ]),
  byRootIdAndPath: new Map(),
  byRootPath: new Map(),
};

const pullRequest = {
  checks: [],
  checksRollup: 'failing' as const,
  headSha: 'sha-1',
  isDraft: false,
  number: 42,
  reviewDecision: null,
  state: 'open' as const,
  title: 'PR',
  url: 'https://example.test/pull/42',
};

function installBridge() {
  const listeners: ((event: ForgePrUpdatedEvent) => void)[] = [];
  const bridge = {
    identity: vi.fn(),
    onPrUpdated: vi.fn((callback: (event: ForgePrUpdatedEvent) => void) => {
      listeners.push(callback);
      return () => {
        listeners.splice(listeners.indexOf(callback), 1);
      };
    }),
    prStatus: vi.fn(),
    refresh: vi.fn(),
  };
  Object.defineProperty(window, 'forge', { configurable: true, value: bridge, writable: true });
  const push = (event: Partial<ForgePrUpdatedEvent>): void => {
    act(() => {
      for (const listener of listeners) {
        listener({
          branch: 'feature/bar',
          generation: 1,
          pullRequest,
          repoCommonDir: COMMON_DIR,
          transitions: ['opened'],
          ...event,
        } as ForgePrUpdatedEvent);
      }
    });
  };
  return { bridge, push };
}

function harness(threads: readonly AssistantMemoryThread[] = [thread()]) {
  const repository = {
    appendThreadRunEvent: vi.fn(async () => undefined),
    updateThreadMetadata: vi.fn(async () => undefined),
  } as unknown as AssistantThreadRepository;
  const notifications = {
    onForgeEvent: vi.fn(),
    onRunFailed: vi.fn(),
    onRunFinished: vi.fn(),
    onToolApprovalRequired: vi.fn(),
  };
  const view = renderHook(() =>
    useForgeRunEvents({
      assistantThreadRepository: repository,
      branchLookup,
      memoryResourceId: 'resource-1',
      notifications,
      selectedMemoryThreadId: 'thread-1',
      threads,
    })
  );
  return { notifications, repository, view };
}

afterEach(() => {
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'forge');
  vi.restoreAllMocks();
});

describe('useForgeRunEvents', () => {
  it('appends pr.opened to the thread’s most recent run and notifies', async () => {
    const { push } = installBridge();
    const { notifications, repository } = harness();
    push({ transitions: ['opened'] });
    await waitFor(() => expect(repository.appendThreadRunEvent).toHaveBeenCalled());
    const [runId, event] = (repository.appendThreadRunEvent as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, { kind: string; label: string; status: string }];
    expect(runId).toBe('run-9');
    expect(event.kind).toBe('pr.opened');
    expect(event.label).toBe('Opened pull request #42');
    expect(notifications.onForgeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'prOpened', prNumber: 42 })
    );
  });

  it('persists forgePrUrl so the jump works offline', async () => {
    const { push } = installBridge();
    const { repository } = harness();
    push({ transitions: ['opened'] });
    await waitFor(() =>
      expect(repository.updateThreadMetadata).toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({ forgePrUrl: 'https://example.test/pull/42' })
      )
    );
  });

  it('records pr.checks but does NOT notify when the thread muted the watch flag', async () => {
    const { push } = installBridge();
    const { notifications, repository } = harness([
      thread({ metadata: { forgePrWatch: false, operatingRootId: 'root-1' } }),
    ]);
    push({ transitions: ['checks'] });
    await waitFor(() => expect(repository.appendThreadRunEvent).toHaveBeenCalled());
    expect(notifications.onForgeEvent).not.toHaveBeenCalled();
  });

  it('notifies for pr.checks when the watch flag is absent (watching by default)', async () => {
    const { push } = installBridge();
    const { notifications } = harness();
    push({ transitions: ['checks'] });
    await waitFor(() =>
      expect(notifications.onForgeEvent).toHaveBeenCalledWith(
        expect.objectContaining({ checksOutcome: 'failing', kind: 'prChecks' })
      )
    );
  });

  it('records pr.checks with a neutral label and does NOT notify when the rollup is unsettled', async () => {
    const { push } = installBridge();
    const { notifications, repository } = harness();
    push({
      pullRequest: { ...pullRequest, checksRollup: 'pending' },
      transitions: ['checks'],
    });
    await waitFor(() => expect(repository.appendThreadRunEvent).toHaveBeenCalled());
    const [, event] = (repository.appendThreadRunEvent as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, { label: string }];
    expect(event.label).toBe('Checks running on pull request #42');
    expect(notifications.onForgeEvent).not.toHaveBeenCalled();
  });

  it('records pr.merged', async () => {
    const { push } = installBridge();
    const { repository } = harness();
    push({
      pullRequest: { ...pullRequest, state: 'merged' },
      transitions: ['merged'],
    });
    await waitFor(() => expect(repository.appendThreadRunEvent).toHaveBeenCalled());
    const [, event] = (repository.appendThreadRunEvent as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, { kind: string }];
    expect(event.kind).toBe('pr.merged');
  });

  it('ignores a push for a repository/branch no thread works on', async () => {
    const { push } = installBridge();
    const { repository } = harness();
    push({ repoCommonDir: '/repos/other/.git' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(repository.appendThreadRunEvent).not.toHaveBeenCalled();
  });

  it('writes no timeline row for a thread with no runs, and still notifies', async () => {
    const { push } = installBridge();
    const { notifications, repository } = harness([thread({ latestRun: undefined })]);
    push({ transitions: ['opened'] });
    await waitFor(() => expect(notifications.onForgeEvent).toHaveBeenCalled());
    expect(repository.appendThreadRunEvent).not.toHaveBeenCalled();
  });

  it('does nothing when a push carries no transitions', async () => {
    const { push } = installBridge();
    const { notifications, repository } = harness();
    push({ transitions: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(repository.appendThreadRunEvent).not.toHaveBeenCalled();
    expect(notifications.onForgeEvent).not.toHaveBeenCalled();
  });
});

describe('useForgeBranchLookupActivation', () => {
  it('starts inactive, never triggering an eager scan on mount', () => {
    installBridge();
    const { result } = renderHook(() => useForgeBranchLookupActivation());
    expect(result.current).toBe(false);
  });

  it('activates on the first forge push, and stays active after later pushes', () => {
    const { push } = installBridge();
    const { result } = renderHook(() => useForgeBranchLookupActivation());

    push({ transitions: ['opened'] });
    expect(result.current).toBe(true);

    push({ transitions: ['checks'] });
    expect(result.current).toBe(true);
  });

  it('stays inactive when no forge bridge is present (web)', () => {
    const { result } = renderHook(() => useForgeBranchLookupActivation());
    expect(result.current).toBe(false);
  });
});
