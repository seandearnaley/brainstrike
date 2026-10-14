import {
  type AssistantMemoryThread,
  type AssistantThreadRepository,
  resetAssistantThreadStore,
  useAssistantThreadStore,
} from '@brainstrike/assistant-data';
import type { ForgePrUpdatedEvent } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FORGE_OBSERVATION_SEQUENCE,
  type ForgeBranchLookup,
  useForgeBranchLookupActivation,
  useForgeRunEvents,
} from '../hooks/use-forge-run-events';

const COMMON_DIR = '/repos/widgets/.git';

const thread = (overrides: Record<string, unknown> = {}): AssistantMemoryThread =>
  ({
    id: 'thread-1',
    latestRun: { id: 'run-9' },
    metadata: { operatingRootId: 'root-1' },
    title: 'Widget work',
    ...overrides,
  }) as unknown as AssistantMemoryThread;

// READY: `useThreadBranchByRootPath`'s post-load state — `available: true`
// and `loaded: true`, maps populated from a resolved `useGitInventory()`.
const branchLookup: ForgeBranchLookup = {
  available: true,
  byRootId: new Map([
    ['root-1', { branch: 'feature/bar', detached: false, gitCommonDir: COMMON_DIR }],
  ]),
  byRootIdAndPath: new Map(),
  byRootPath: new Map(),
  loaded: true,
};

// NOT READY: the same shape `useThreadBranchByRootPath` returns the instant
// `enabled` flips true, before its `useGitInventory()` load has resolved —
// `available: true` (the bridge exists) but `loaded: false` and every map
// still empty (BST-1391 M2's probe starting state).
const NOT_READY_BRANCH_LOOKUP: ForgeBranchLookup = {
  available: true,
  byRootId: new Map(),
  byRootIdAndPath: new Map(),
  byRootPath: new Map(),
  loaded: false,
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
  // Auto-increments unless a test explicitly overrides `generation` in a
  // `push()` call — most tests don't care about ordering and would
  // otherwise all collide on the same generation, which the hook's
  // out-of-order guard (BST-1391 fix-round 3) would reject as stale after
  // the first delivery.
  let nextGeneration = 1;
  const bridge = {
    cacheSnapshot: async () => ({ ok: true as const, value: [] }),
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
    const generation = event.generation ?? nextGeneration;
    nextGeneration = generation + 1;
    act(() => {
      for (const listener of listeners) {
        listener({
          branch: 'feature/bar',
          generation,
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

const RESOURCE_ID = 'resource-1';

function harness(
  threads: readonly AssistantMemoryThread[] = [thread()],
  initialBranchLookup: ForgeBranchLookup = branchLookup
) {
  const repository = {
    appendThreadRunEvent: vi.fn(async () => undefined),
    updateThreadMetadata: vi.fn(async () => undefined),
  } as unknown as AssistantThreadRepository;
  const notifications = {
    onForgeEvent: vi.fn(),
    onRunFailed: vi.fn(),
    onRunFinished: vi.fn(),
    onRunNotification: vi.fn(),
    onToolApprovalRequired: vi.fn(),
  };
  // Seeds the REAL `useAssistantThreadStore` (the same module-singleton
  // `persistForgePrUrl` now writes through, BST-1391 fix-round 3) and reads
  // `threads` back from it reactively, mirroring exactly how
  // `assistant-ui-panel-wrapper.tsx` derives `memoryThreads`. A static
  // closure array here would never reflect a write this hook itself just
  // issued, defeating the point of testing the store-routed guard.
  useAssistantThreadStore.setState({
    threadsByResourceId: { [RESOURCE_ID]: [...threads] },
  });
  const view = renderHook(
    (props: { branchLookup: ForgeBranchLookup }) => {
      const liveThreads = useAssistantThreadStore(
        (state) => state.threadsByResourceId[RESOURCE_ID] ?? threads
      );
      useForgeRunEvents({
        assistantThreadRepository: repository,
        branchLookup: props.branchLookup,
        memoryResourceId: RESOURCE_ID,
        notifications,
        threads: liveThreads,
      });
    },
    { initialProps: { branchLookup: initialBranchLookup } }
  );
  return { notifications, repository, view };
}

afterEach(() => {
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'forge');
  vi.restoreAllMocks();
  // `persistForgePrUrl` now writes through the REAL, module-singleton
  // `useAssistantThreadStore` (BST-1391 fix-round 3) — reset it so one
  // test's write can never leak into the next.
  resetAssistantThreadStore();
});

describe('useForgeRunEvents', () => {
  it('appends pr.opened to the thread’s most recent run and notifies', async () => {
    const { push } = installBridge();
    const { notifications, repository } = harness();
    push({ transitions: ['opened'] });
    await waitFor(() => expect(repository.appendThreadRunEvent).toHaveBeenCalled());
    const [runId, event] = (repository.appendThreadRunEvent as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, { kind: string; label: string; sequence: number; status: string }];
    expect(runId).toBe('run-9');
    expect(event.kind).toBe('pr.opened');
    expect(event.label).toBe('Opened pull request #42');
    // BST-1391 M3: a forge row's sequence must sort after every real stream
    // step of the run it is attached to — see `FORGE_OBSERVATION_SEQUENCE`'s
    // doc for why this specific constant is safe against the int4 column.
    expect(event.sequence).toBe(FORGE_OBSERVATION_SEQUENCE);
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
    // BST-1391 L6: only the forge key is written — `updateThreadMetadata`
    // merges server-side, so spreading the (possibly stale) thread metadata
    // snapshot back would risk reverting an unrelated key.
    const [, metadata] = (repository.updateThreadMetadata as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, Record<string, unknown>];
    expect(metadata).toEqual({ forgePrUrl: 'https://example.test/pull/42' });
  });

  it('does not re-issue an identical forgePrUrl write on a second transition for the same PR (L6)', async () => {
    const { push } = installBridge();
    const { repository } = harness();
    push({ transitions: ['opened'] });
    await waitFor(() => expect(repository.updateThreadMetadata).toHaveBeenCalledTimes(1));
    // A second push for the SAME PR/url (`checks`) must not repeat the write,
    // even though the `threads` prop snapshot was never refreshed to reflect
    // the first write — `persistForgePrUrl` tracks it via its own ref map.
    push({ transitions: ['checks'] });
    await waitFor(() => expect(repository.appendThreadRunEvent).toHaveBeenCalledTimes(2));
    expect(repository.updateThreadMetadata).toHaveBeenCalledTimes(1);
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

  it('notifies for pr.checks when forgePrWatch is explicitly true (L8, the other branch)', async () => {
    const { push } = installBridge();
    const { notifications } = harness([
      thread({ metadata: { forgePrWatch: true, operatingRootId: 'root-1' } }),
    ]);
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

  it('records pr.checks with a "New commits" label when the rollup is none (L8)', async () => {
    const { push } = installBridge();
    const { notifications, repository } = harness();
    push({
      pullRequest: { ...pullRequest, checksRollup: 'none' },
      transitions: ['checks'],
    });
    await waitFor(() => expect(repository.appendThreadRunEvent).toHaveBeenCalled());
    const [, event] = (repository.appendThreadRunEvent as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, { label: string }];
    expect(event.label).toBe('New commits on pull request #42');
    expect(notifications.onForgeEvent).not.toHaveBeenCalled();
  });

  it('records pr.checks as passed/completed and notifies when the rollup settles passing (L8)', async () => {
    const { push } = installBridge();
    const { notifications, repository } = harness();
    push({
      pullRequest: { ...pullRequest, checksRollup: 'passing' },
      transitions: ['checks'],
    });
    await waitFor(() => expect(repository.appendThreadRunEvent).toHaveBeenCalled());
    const [, event] = (repository.appendThreadRunEvent as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, { label: string; status: string }];
    expect(event.label).toBe('Checks passed on pull request #42');
    expect(event.status).toBe('completed');
    expect(notifications.onForgeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ checksOutcome: 'passing', kind: 'prChecks' })
    );
  });

  it('records pr.merged and does NOT notify (no prMerged notification kind, L8)', async () => {
    const { push } = installBridge();
    const { notifications, repository } = harness();
    push({
      pullRequest: { ...pullRequest, state: 'merged' },
      transitions: ['merged'],
    });
    await waitFor(() => expect(repository.appendThreadRunEvent).toHaveBeenCalled());
    const [, event] = (repository.appendThreadRunEvent as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, { kind: string }];
    expect(event.kind).toBe('pr.merged');
    expect(notifications.onForgeEvent).not.toHaveBeenCalled();
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

  it('unsubscribes from the bridge on unmount (L8)', async () => {
    const { bridge, push } = installBridge();
    const { repository, view } = harness();
    expect(bridge.onPrUpdated).toHaveBeenCalledTimes(1);
    view.unmount();
    push({ transitions: ['opened'] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(repository.appendThreadRunEvent).not.toHaveBeenCalled();
  });

  describe('generation guard (BST-1391 fix-round 3)', () => {
    it('drops an out-of-order (stale) delivery, appending nothing for it', async () => {
      const { push } = installBridge();
      const { repository } = harness();

      // Establishes generation 5 as "last seen" via a normal, processed push.
      push({ generation: 5, transitions: ['opened'] });
      await waitFor(() => expect(repository.appendThreadRunEvent).toHaveBeenCalledTimes(1));

      // A delivery whose generation does not exceed the last one seen is
      // stale/out-of-order per `ForgePrUpdatedEvent.generation`'s documented
      // contract ("consumers drop stale deliveries") — it must be dropped
      // outright, not processed.
      push({ generation: 3, transitions: ['checks'] });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(repository.appendThreadRunEvent).toHaveBeenCalledTimes(1);
    });

    it('drops a duplicate delivery at the SAME generation as the last one seen', async () => {
      const { push } = installBridge();
      const { repository } = harness();

      push({ generation: 5, transitions: ['opened'] });
      await waitFor(() => expect(repository.appendThreadRunEvent).toHaveBeenCalledTimes(1));

      push({ generation: 5, transitions: ['checks'] });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(repository.appendThreadRunEvent).toHaveBeenCalledTimes(1);
    });
  });

  describe('branch-lookup readiness (BST-1391 M2)', () => {
    it('reproduces the reviewer probe: the activating push buffers, then drains to exactly one append and one notify', async () => {
      const { push } = installBridge();
      const { notifications, repository, view } = harness([thread()], NOT_READY_BRANCH_LOOKUP);

      // This is the push whose arrival is what flips
      // `useForgeBranchLookupActivation` on in the real wrapper — at this
      // instant the branch lookup's maps are still empty because the load it
      // just triggered has not resolved. The ORIGINAL bug: this exact push
      // matched nothing and was dropped for good.
      push({ transitions: ['opened'] });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(repository.appendThreadRunEvent).not.toHaveBeenCalled();
      expect(notifications.onForgeEvent).not.toHaveBeenCalled();

      // The branch lookup's load resolves — the wrapper hands
      // `useForgeRunEvents` a fresh, populated, `loaded: true` lookup object.
      act(() => {
        view.rerender({ branchLookup });
      });

      await waitFor(() => expect(repository.appendThreadRunEvent).toHaveBeenCalledTimes(1));
      expect(notifications.onForgeEvent).toHaveBeenCalledTimes(1);
      const [runId, event] = (repository.appendThreadRunEvent as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, { kind: string }];
      expect(runId).toBe('run-9');
      expect(event.kind).toBe('pr.opened');
      expect(notifications.onForgeEvent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'prOpened', prNumber: 42 })
      );
    });

    it('bounds the pending buffer to the LATEST push per repo/branch (inverted reviewer probe)', async () => {
      const { push } = installBridge();
      const { notifications, repository, view } = harness([thread()], NOT_READY_BRANCH_LOOKUP);

      // 50 pushes for the SAME repo/branch while the lookup is still
      // loading (e.g. a flurry of force-pushes) — each carries a distinct
      // headSha, simulating the head genuinely moving each time. Before the
      // bounded-buffer fix, an unbounded array retained all 50 and drained
      // every one: 50 appends, 50 notifications, most with a superseded
      // headSha the branch had already moved past.
      for (let i = 0; i < 50; i += 1) {
        push({
          pullRequest: { ...pullRequest, headSha: `sha-${i}` },
          transitions: ['checks'],
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(repository.appendThreadRunEvent).not.toHaveBeenCalled();
      expect(notifications.onForgeEvent).not.toHaveBeenCalled();

      act(() => {
        view.rerender({ branchLookup });
      });

      // Exactly one append, one notify — the buffer held only the LATEST
      // (sha-49) push once it became ready, not all 50.
      await waitFor(() => expect(repository.appendThreadRunEvent).toHaveBeenCalledTimes(1));
      expect(notifications.onForgeEvent).toHaveBeenCalledTimes(1);
      expect(notifications.onForgeEvent).toHaveBeenCalledWith(
        expect.objectContaining({ observationKey: expect.stringContaining('sha-49') })
      );
    });

    it('does not double-append a drained observation that arrives again afterward', async () => {
      const { push } = installBridge();
      const { repository, view } = harness([thread()], NOT_READY_BRANCH_LOOKUP);

      push({ transitions: ['opened'] });
      act(() => {
        view.rerender({ branchLookup });
      });
      await waitFor(() => expect(repository.appendThreadRunEvent).toHaveBeenCalledTimes(1));

      // The SAME observation (same repo/branch/headSha/transition) is pushed
      // again live, now that the lookup is ready. `appendThreadRunEvent` has
      // no coalescing of its own, so without the shared
      // `processedTransitionKeys` set this would append a second, identical
      // timeline row.
      push({ transitions: ['opened'] });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(repository.appendThreadRunEvent).toHaveBeenCalledTimes(1);
    });

    it('does not buffer a push that is a true non-match once the lookup is ready', async () => {
      const { push } = installBridge();
      const { repository, view } = harness([thread()], branchLookup);

      // A different repository entirely — no thread will ever match this,
      // ready or not.
      push({ repoCommonDir: '/repos/other/.git' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(repository.appendThreadRunEvent).not.toHaveBeenCalled();

      // If the non-match had been buffered by mistake, a later readiness
      // identity change would drain it and wrongly append a row.
      act(() => {
        view.rerender({ branchLookup: { ...branchLookup, byRootPath: new Map() } });
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(repository.appendThreadRunEvent).not.toHaveBeenCalled();
    });
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

  it('unsubscribes from the bridge on unmount (L8)', () => {
    const { bridge, push } = installBridge();
    const { result, unmount } = renderHook(() => useForgeBranchLookupActivation());
    expect(bridge.onPrUpdated).toHaveBeenCalledTimes(1);
    unmount();
    push({ transitions: ['opened'] });
    expect(result.current).toBe(false);
  });
});
