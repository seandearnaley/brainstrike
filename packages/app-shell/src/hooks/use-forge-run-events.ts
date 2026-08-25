/**
 * Turns main's `forge:prUpdated` pushes into thread-visible facts: a durable
 * timeline row, the durable `forgePrUrl`, and an OS notification.
 *
 * WHY IT LIVES IN APP-SHELL, not in `@brainstrike/assistant-ui`: the existing
 * `useRunLifecycleNotifications` derives events by SCANNING streamed message
 * parts, and a forge observation is not in the stream — it arrives out of band
 * from the main process. This hook is the forge equivalent of that trigger
 * source, and it reports through the SAME decision layer
 * (`useAssistantRunNotifications`), so the focus/permission/coalescing gates
 * are shared and there is no second notification path.
 *
 * ATTRIBUTION: the `pr.*` row is appended to the thread's MOST RECENT run —
 * the run whose push produced the pull request. `run_id` is NOT NULL with an
 * FK to the renderer-bootstrapped thread-runs table, so a thread with no runs
 * gets no row; that is logged, and the chip and the pill still show the PR.
 *
 * KNOWN LIMITATION — reload visibility (BST-1391 M4): `appendThreadRunEvent`
 * writes the `pr.*` row durably, but the assistant-run-timeline UI renders
 * from data parts on the message stream, hydrated from
 * `listThreadRunEvents` ONLY when a thread's history is loaded
 * (`createAssistantThreadHistoryAdapter`). Nothing re-hydrates an
 * ALREADY-OPEN thread mid-session, so a `pr.*` row appended while its thread
 * is open does not appear until that thread is reopened or the app reloads. This is NOT a case of the
 * timeline lagging behind a live `forgePrUrl`: `useAssistantThreadStore` is
 * REFRESH-DRIVEN (`refreshResourceThreads`), not a live query, so
 * `forgePrUrl` does not update live either. The PR chip and thread-row
 * pill stay fresh through their OWN independent live sources instead —
 * `use-thread-forge-pr.ts` reads `window.forge` directly (the chip), and
 * `use-forge-pr-cache.ts` reads a PGlite live query over
 * `brainstrike_forge_prs` (the pill, Task 5) — neither reads
 * `thread.metadata` or `listThreadRunEvents` at all. See
 * `docs/agents/assistant-persistence.md`'s "ASSISTANT RUN NOTIFICATIONS"
 * layer 6 for the full writeup. Not fixed here: inventing a live-refresh path
 * is future work, not this task's.
 */
import type { ForgeNotificationEvent } from '@brainstrike/app-state/notifications/run-notification-dispatcher';
import {
  type AssistantMemoryThread,
  type AssistantThreadRepository,
  useAssistantThreadStore,
} from '@brainstrike/assistant-data';
import { createLogger } from '@brainstrike/logging';
import type { ForgePrTransition, ForgePrUpdatedEvent, ForgePullRequest } from '@brainstrike/types';
import { useEffect, useMemo, useRef, useState } from 'react';
import { resolveForgeBridge } from '../forge/forge-bridge';
import { lookupThreadBranch, type ThreadBranchLookup } from '../thread-branch-resolution';
import type { AssistantRunNotificationCallbacks } from '../use-assistant-run-notifications';

const logger = createLogger('ForgeRunEvents');

const EVENT_KIND: Readonly<Record<ForgePrTransition, 'pr.checks' | 'pr.merged' | 'pr.opened'>> = {
  checks: 'pr.checks',
  merged: 'pr.merged',
  opened: 'pr.opened',
};

/**
 * The branch lookup `useForgeRunEvents` needs, PLUS the readiness the plain
 * `ThreadBranchLookup` (shared with the Threads panel's branch chips) does
 * not carry: `available` and `loaded`, threaded straight from
 * `ThreadBranchByRootPathState` (see that type's doc). `lookupThreadBranch`
 * only ever needs the three maps — this hook additionally needs to tell
 * "the maps are empty because nothing matches" apart from "the maps are
 * empty because the load hasn't resolved yet", which is exactly what M2
 * (BST-1391) requires: a push that arrives during the second case must be
 * buffered, not treated as a real non-match. See `isLookupReady`.
 */
export type ForgeBranchLookup = ThreadBranchLookup & {
  /** Whether the desktop git-inventory bridge is present at all. `false`
   * means the lookup will NEVER produce data (web, or no bridge) — a push
   * against it is a true non-match, not a "still loading" state. */
  readonly available: boolean;
  /** Whether the underlying git inventory has resolved at least once since
   * `useForgeBranchLookupActivation` flipped it on. `false` while
   * `available` is `true` means the first scan is still in flight. */
  readonly loaded: boolean;
};

export interface UseForgeRunEventsArgs {
  readonly assistantThreadRepository: AssistantThreadRepository | null;
  readonly branchLookup: ForgeBranchLookup;
  readonly memoryResourceId: string;
  readonly notifications: AssistantRunNotificationCallbacks;
  readonly threads: readonly AssistantMemoryThread[];
}

/**
 * Whether `branchLookup`'s current contents can be trusted to answer a match
 * question NOW. Either the git bridge will never have data (`!available`,
 * e.g. web) — in which case an empty map is a permanent, honest fact — or it
 * IS available and its current load has actually resolved (`loaded`). The
 * false case (`available && !loaded`) is the ONLY state where an empty map
 * means "ask again later", not "no".
 */
function isLookupReady(branchLookup: ForgeBranchLookup): boolean {
  return !branchLookup.available || branchLookup.loaded;
}

function describe(
  transition: ForgePrTransition,
  pullRequest: ForgePullRequest
): {
  readonly detail: string;
  readonly label: string;
  readonly status: 'completed' | 'failed' | 'info';
} {
  if (transition === 'opened') {
    return {
      detail: pullRequest.title,
      label: `Opened pull request #${pullRequest.number}`,
      status: 'info',
    };
  }
  if (transition === 'merged') {
    return {
      detail: pullRequest.title,
      label: `Merged pull request #${pullRequest.number}`,
      status: 'completed',
    };
  }
  // `checks` also fires when only the head sha moved (F6), so the rollup can
  // still be unsettled here. Never assert a verdict from a `'pending'` or
  // `'none'` rollup — fall back to a neutral label instead.
  if (pullRequest.checksRollup === 'pending') {
    return {
      detail: pullRequest.title,
      label: `Checks running on pull request #${pullRequest.number}`,
      status: 'info',
    };
  }
  if (pullRequest.checksRollup === 'none') {
    return {
      detail: pullRequest.title,
      label: `New commits on pull request #${pullRequest.number}`,
      status: 'info',
    };
  }
  const failing = pullRequest.checksRollup === 'failing';
  return {
    detail: pullRequest.checks.map((check) => check.name).join(', '),
    label: `Checks ${failing ? 'failed' : 'passed'} on pull request #${pullRequest.number}`,
    status: failing ? 'failed' : 'completed',
  };
}

type ForgeTimelineCopy = ReturnType<typeof describe>;

/**
 * The `sequence` every forge timeline row is stored with.
 *
 * `brainstrike_assistant_run_events.sequence` is a Postgres `integer` (int4,
 * max 2_147_483_647 — see the `CREATE TABLE` in
 * `assistant-memory-repository.ts`), and the reader orders
 * `sequence ASC, occurred_at ASC, id ASC`. The agent stream's own live
 * counter starts at 0/1 and stays small for the lifetime of a single run, so
 * `0` (the previous value here) sorted a `pr.*` observation BEFORE every real
 * step of the run it was attached to (BST-1391 M3) — exactly backwards, since
 * a forge push is always a REACTION to a run that already happened.
 * `1_000_000_000` is comfortably below the int4 ceiling and comfortably above
 * any stream counter a real run could reach, so a forge row always sorts
 * after the run's own steps. Two forge rows on the SAME run tie on
 * `sequence` and fall back to `occurred_at` for their relative order, which
 * is correct — they are independent observations, not a span with an
 * internal order of their own.
 */
export const FORGE_OBSERVATION_SEQUENCE = 1_000_000_000;

function appendTimelineRow(input: {
  readonly copy: ForgeTimelineCopy;
  readonly event: ForgePrUpdatedEvent;
  readonly pullRequest: ForgePullRequest;
  readonly repository: AssistantThreadRepository | null;
  readonly thread: AssistantMemoryThread;
  readonly transition: ForgePrTransition;
}): void {
  const { copy, event, pullRequest, repository, thread, transition } = input;
  const runId = thread.latestRun?.id;
  // Split so each absent precondition logs its OWN true reason (BST-1391 L5)
  // rather than a single message that can't tell a run-less thread apart
  // from a caller with no repository capability at all.
  if (!runId) {
    logger.info('Forge observation has no run to attach a timeline row to', {
      prNumber: pullRequest.number,
      threadId: thread.id,
    });
    return;
  }
  if (!repository) {
    logger.info('Forge observation cannot attach a timeline row: no thread repository available', {
      prNumber: pullRequest.number,
      threadId: thread.id,
    });
    return;
  }
  repository
    .appendThreadRunEvent(runId, {
      detail: copy.detail,
      id: crypto.randomUUID(),
      kind: EVENT_KIND[transition],
      label: copy.label,
      metadata: {
        branch: event.branch,
        checksRollup: pullRequest.checksRollup,
        prNumber: pullRequest.number,
        prUrl: pullRequest.url,
        repoCommonDir: event.repoCommonDir,
      },
      sequence: FORGE_OBSERVATION_SEQUENCE,
      status: copy.status,
      timestamp: new Date().toISOString(),
    })
    .catch((error: unknown) => {
      logger.error('Failed to append a forge run event', {
        error,
        runId,
        threadId: thread.id,
      });
    });
}

/**
 * Writes `thread.metadata.forgePrUrl` through the CANONICAL store writer
 * (`useAssistantThreadStore.getState().updateThreadMetadata`) — the same
 * path `use-workspace-bar.ts:554`, `use-assistant-thread-root-binding.ts:103`,
 * and `threads-panel.tsx:3115` use — instead of a raw
 * `repository.updateThreadMetadata` call (BST-1391 fix-round 3):
 *
 * 1. `updateThreadMetadata` MERGES server-side
 *    (`SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb` —
 *    `assistant-memory-repository.ts`), so this writes ONLY the forge key.
 *    Spreading `thread.metadata` back would re-persist a possibly-stale
 *    snapshot over every OTHER key.
 * 2. The store writer ALSO merges the write into
 *    `useAssistantThreadStore`'s `threadsByResourceId` (see its
 *    implementation in `assistant-thread-store.ts`), which is the SAME
 *    in-memory list this hook reads as `args.threads`
 *    (`memoryThreads` in the wrapper) and the same list the offline
 *    "jump to PR" affordance reads. A raw repository call bypassed that
 *    store entirely, so `thread.metadata.forgePrUrl` never caught up within
 *    a session — the guard below always compared against a snapshot from
 *    before this hook's own first write. Routing through the store closes
 *    that loop: the NEXT push sees the write reflected in `args.threads`.
 *
 * No separate "last written" ref (an earlier round used one to paper over
 * exactly the staleness (2) now fixes at the source): once the store merge
 * makes `thread.metadata.forgePrUrl` catch up across pushes, comparing
 * against it directly is sufficient. The one gap this accepts: two
 * transitions for the SAME thread inside a SINGLE push (e.g.
 * `['opened','checks']` sharing one `pullRequest`) can each pass the guard
 * before the first write's store `set()` lands, issuing one redundant —
 * but idempotent, same-value — write. Not worth a ref to close.
 */
function persistForgePrUrl(
  repository: AssistantThreadRepository | null,
  resourceId: string,
  thread: AssistantMemoryThread,
  pullRequest: ForgePullRequest
): void {
  if (!repository) {
    return;
  }
  if (thread.metadata?.forgePrUrl === pullRequest.url) {
    return;
  }
  useAssistantThreadStore
    .getState()
    .updateThreadMetadata(repository, resourceId, thread.id, { forgePrUrl: pullRequest.url })
    .catch((error: unknown) => {
      logger.error('Failed to persist the thread forge PR URL', {
        error,
        threadId: thread.id,
      });
    });
}

function recordTransition(input: {
  readonly event: ForgePrUpdatedEvent;
  readonly matching: readonly AssistantMemoryThread[];
  readonly pullRequest: ForgePullRequest;
  readonly repository: AssistantThreadRepository | null;
  readonly resourceId: string;
  readonly transition: ForgePrTransition;
}): void {
  const { event, matching, pullRequest, repository, resourceId, transition } = input;
  const copy = describe(transition, pullRequest);
  for (const thread of matching) {
    appendTimelineRow({ copy, event, pullRequest, repository, thread, transition });
    persistForgePrUrl(repository, resourceId, thread, pullRequest);
  }
}

function buildForgeNotification(input: {
  readonly matching: readonly AssistantMemoryThread[];
  readonly observationKey: string;
  readonly pullRequest: ForgePullRequest;
  readonly transition: ForgePrTransition;
}): ForgeNotificationEvent | undefined {
  const { matching, observationKey, pullRequest, transition } = input;
  if (transition === 'merged') {
    // No `prMerged` notification kind: §11 defines toggles for opened and
    // checks only, and a merge is already visible as a faded pill.
    return;
  }
  if (
    transition === 'checks' &&
    (pullRequest.checksRollup === 'pending' || pullRequest.checksRollup === 'none')
  ) {
    // F6: `checks` also fires when only the head sha moved, so the rollup may
    // still be unsettled. The timeline row is neutral and there is no verdict
    // to notify on yet.
    return;
  }
  const watchingThread = matching.find((thread) => thread.metadata?.forgePrWatch !== false);
  if (!watchingThread) {
    return;
  }
  if (transition === 'opened') {
    return {
      kind: 'prOpened',
      observationKey,
      prNumber: pullRequest.number,
      ...(watchingThread.title ? { threadTitle: watchingThread.title } : {}),
    };
  }
  return {
    checksOutcome: pullRequest.checksRollup === 'failing' ? 'failing' : 'passing',
    kind: 'prChecks',
    observationKey,
    prNumber: pullRequest.number,
    ...(watchingThread.title ? { threadTitle: watchingThread.title } : {}),
  };
}

function matchingThreads(
  event: ForgePrUpdatedEvent,
  threads: readonly AssistantMemoryThread[],
  branchLookup: ForgeBranchLookup
): readonly AssistantMemoryThread[] {
  return threads.filter((thread) => {
    const resolved = lookupThreadBranch(thread, branchLookup);
    return resolved?.branch === event.branch && resolved.gitCommonDir === event.repoCommonDir;
  });
}

/**
 * `'processed'` — matched at least one thread and recorded every transition.
 * `'ignored'` — a true non-match (or an empty-transitions/null-PR push): the
 * branch lookup was ready and had nothing to say.
 * `'buffered'` — matched nothing, but the branch lookup is NOT ready yet
 * (BST-1391 M2), so this is NOT a real non-match. The caller must retain the
 * event and retry it once `isLookupReady` flips true — see the drain effect
 * in `useForgeRunEvents`.
 */
type ForgePushOutcome = 'buffered' | 'ignored' | 'processed';

function handleForgePrUpdated(
  event: ForgePrUpdatedEvent,
  args: UseForgeRunEventsArgs,
  processedTransitionKeys: Set<string>
): ForgePushOutcome {
  const { assistantThreadRepository, branchLookup, memoryResourceId, notifications, threads } =
    args;
  const { pullRequest, transitions } = event;
  if (transitions.length === 0 || pullRequest === null) {
    return 'ignored';
  }
  const matching = matchingThreads(event, threads, branchLookup);
  if (matching.length === 0) {
    if (!isLookupReady(branchLookup)) {
      return 'buffered';
    }
    // Ready and still no match: an honest non-match, not a silent drop — the
    // caller is a thread-list scan, not a fallback path, so this is a
    // routine "no thread works on this branch" outcome and stays at debug.
    logger.debug(
      'Forge push matched no thread; the branch lookup is loaded, so this is a true non-match',
      {
        branch: event.branch,
        repoCommonDir: event.repoCommonDir,
      }
    );
    return 'ignored';
  }
  // `\0`-separated to match the forge-service cache key convention
  // (`apps/desktop/src/assistant-server/forge-service.ts`'s `cacheKey`) —
  // BST-1391 L9.
  const observationKey = `${event.repoCommonDir}\0${event.branch}\0${pullRequest.headSha}`;
  for (const transition of transitions) {
    const transitionKey = `${observationKey}\0${transition}`;
    if (processedTransitionKeys.has(transitionKey)) {
      // Already recorded — either a live push repeated the exact same
      // observation, or the drain effect is retrying a buffered event that
      // was already drained. `appendThreadRunEvent` has no coalescing of its
      // own (unlike the notification dispatcher's `dispatchedKeys`), so this
      // is what stops a double timeline row (BST-1391 M2).
      continue;
    }
    processedTransitionKeys.add(transitionKey);
    recordTransition({
      event,
      matching,
      pullRequest,
      repository: assistantThreadRepository,
      resourceId: memoryResourceId,
      transition,
    });
    const notification = buildForgeNotification({
      matching,
      observationKey,
      pullRequest,
      transition,
    });
    if (notification) {
      notifications.onForgeEvent(notification);
    }
  }
  return 'processed';
}

/**
 * Whether the forge branch-lookup inventory scan should be ACTIVE.
 *
 * `useThreadBranchByRootPath`'s `enabled` flag drives a full repo/worktree
 * `useGitInventory` scan (BST-1116 W6 review finding 4: not free, and must
 * not run merely because a surface mounted). The Threads panel already pays
 * for that scan only in folder-grouping view; mounting a SECOND always-on
 * instance in the assistant panel wrapper — `enabled: true` unconditionally —
 * would double that cost on every panel mount, which is exactly the cost
 * BST-1116's gating exists to avoid.
 *
 * So this hook starts INACTIVE and flips to active the first time a
 * `forge:prUpdated` push arrives — the first real signal that a branch
 * lookup will actually be needed to match a push to a thread. From then on,
 * `useThreadBranchByRootPath({ enabled: true })`'s own invalidation-driven
 * refresh keeps the lookup live (see `useGitInventory`'s `deferInitialLoad`
 * doc — a false→true `enabled` transition performs the first real load).
 *
 * THE COST IS DEFERRED, NOT REMOVED (BST-1391 L7): this only postpones the
 * FIRST scan until it is provably needed; it does not shrink or dedupe it.
 * If the Threads panel is ALSO in folder-grouping view when the first push
 * arrives, that is a SEPARATE `useThreadBranchByRootPath` instance
 * (`threads-panel.tsx`) — both are already active for their own reasons and
 * each independently re-scans on the SAME `forge:prUpdated`-driven
 * invalidation, i.e. the cost can be paid TWICE concurrently rather than
 * shared. A single cache keyed by inventory generation, shared across every
 * `useThreadBranchByRootPath` caller, would remove that duplication — that is
 * future work, not this task's.
 *
 * The very first push commonly arrives before the load THIS activation
 * triggers has resolved, and `matchingThreads` (in `use-forge-run-events.ts`)
 * necessarily sees empty maps at that instant. `useForgeRunEvents` does NOT
 * treat that as a non-match: it buffers the push and drains it once
 * `isLookupReady` reports the load has resolved (BST-1391 M2) — the push
 * that woke this hook up is not the one exception that goes unmatched.
 */
export function useForgeBranchLookupActivation(): boolean {
  const bridge = useMemo(() => resolveForgeBridge(), []);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!bridge || active) {
      return;
    }
    return bridge.onPrUpdated(() => {
      setActive(true);
    });
  }, [bridge, active]);

  return active;
}

/** `<repoCommonDir>\0<branch>` — the pending-buffer key. Deliberately coarser
 * than `observationKey` (no headSha): the buffer holds at most one PENDING
 * push per repo/branch, so a burst of pushes for the same branch (e.g. a
 * flurry of force-pushes while the lookup is still loading) collapses to the
 * latest one instead of growing without bound (BST-1391 fix-round finding —
 * the reviewer's probe: 50 pushes while not-ready produced 50 buffered
 * entries and, once drained, 50 notifications carrying superseded headShas).
 * Only the LATEST push's state matters once the lookup is ready: an earlier
 * pending push for the same branch is already stale by construction. */
function pendingBufferKey(event: ForgePrUpdatedEvent): string {
  return `${event.repoCommonDir}\0${event.branch}`;
}

export function useForgeRunEvents(args: UseForgeRunEventsArgs): void {
  const bridge = useMemo(() => resolveForgeBridge(), []);
  const { assistantThreadRepository, branchLookup, memoryResourceId, notifications, threads } =
    args;
  // The push handler must see the CURRENT threads/lookup without
  // resubscribing to the bridge on every thread-store tick — a resubscribe
  // would drop pushes in flight — which is why a ref is used at all. Render
  // must stay pure (react-doctor/no-ref-current-in-render, BST-1391
  // fix-round 3), so the WRITE itself happens in the effect below, deferred
  // to after commit, keyed on the individual fields this hook reads (not
  // `args` itself, a fresh object every render that would make the
  // dependency array a no-op).
  const latest = useRef(args);
  useEffect(() => {
    latest.current = {
      assistantThreadRepository,
      branchLookup,
      memoryResourceId,
      notifications,
      threads,
    };
  }, [assistantThreadRepository, branchLookup, memoryResourceId, notifications, threads]);

  // Pushes `handleForgePrUpdated` returned `'buffered'` for — matched no
  // thread while the branch lookup was still loading. Retained rather than
  // dropped so the push that flips `useForgeBranchLookupActivation` active is
  // not the one push guaranteed to be lost (BST-1391 M2). Keyed by
  // `pendingBufferKey` (repo+branch, NOT headSha) and bounded to one entry
  // per key — see that function's doc for why a headSha-keyed queue would
  // grow unbounded across a burst of pushes for the same branch.
  const pendingRef = useRef<Map<string, ForgePrUpdatedEvent>>(new Map());
  // Every `<observationKey>\0<transition>` already recorded, live OR drained.
  // Shared across both paths so a drain that fires more than once for the
  // same buffered push cannot double-append a timeline row — see
  // `handleForgePrUpdated`'s dedupe check.
  const processedTransitionKeysRef = useRef<Set<string>>(new Set());
  // `ForgePrUpdatedEvent.generation` is documented as a monotonic
  // per-main-process counter whose "consumers drop stale deliveries"
  // (`packages/types/src/forge.ts`). This hook performs durable writes (a
  // timeline row, `forgePrUrl`), so a re-ordered or duplicated IPC delivery
  // must not resurrect an already-superseded observation — honored here by
  // dropping any push whose generation does not strictly advance past the
  // last one this hook instance has seen.
  const lastSeenGenerationRef = useRef(0);

  useEffect(() => {
    if (!bridge) {
      return;
    }
    return bridge.onPrUpdated((event: ForgePrUpdatedEvent) => {
      if (event.generation <= lastSeenGenerationRef.current) {
        logger.debug('Dropping an out-of-order or duplicate forge push', {
          generation: event.generation,
          lastSeenGeneration: lastSeenGenerationRef.current,
        });
        return;
      }
      lastSeenGenerationRef.current = event.generation;
      const outcome = handleForgePrUpdated(
        event,
        latest.current,
        processedTransitionKeysRef.current
      );
      if (outcome === 'buffered') {
        const bufferKey = pendingBufferKey(event);
        const replacing = pendingRef.current.has(bufferKey);
        pendingRef.current.set(bufferKey, event);
        logger.debug(
          replacing
            ? 'Forge push buffered, replacing an earlier pending push for this repo/branch'
            : 'Forge push buffered pending the branch lookup',
          { branch: event.branch, repoCommonDir: event.repoCommonDir }
        );
      }
    });
  }, [bridge]);

  // Drains buffered pushes once the branch lookup can actually answer them.
  // Keyed on `branchLookup`'s own identity (a fresh object from the wrapper
  // every time `useThreadBranchByRootPath` resolves a load), not on a timer
  // or the thread list, so this fires exactly when there is new information
  // to retry buffered pushes against — see `isLookupReady`.
  useEffect(() => {
    if (pendingRef.current.size === 0 || !isLookupReady(branchLookup)) {
      return;
    }
    const draining = [...pendingRef.current.values()];
    pendingRef.current = new Map();
    for (const event of draining) {
      // A re-buffer here would be a bug (this effect only runs once
      // `isLookupReady` is true), but `handleForgePrUpdated` returning
      // `'buffered'` again is handled the same as any other outcome: the
      // event is simply not re-queued, so a stuck lookup cannot loop.
      handleForgePrUpdated(event, latest.current, processedTransitionKeysRef.current);
    }
  }, [branchLookup]);
}
