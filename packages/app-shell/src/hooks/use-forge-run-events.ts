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
 */
import type { ForgeNotificationEvent } from '@brainstrike/app-state/notifications/run-notification-dispatcher';
import type { AssistantMemoryThread, AssistantThreadRepository } from '@brainstrike/assistant-data';
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

export interface UseForgeRunEventsArgs {
  readonly assistantThreadRepository: AssistantThreadRepository | null;
  readonly branchLookup: ThreadBranchLookup;
  readonly memoryResourceId: string;
  readonly notifications: AssistantRunNotificationCallbacks;
  readonly selectedMemoryThreadId: string | undefined;
  readonly threads: readonly AssistantMemoryThread[];
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
  if (!(runId && repository)) {
    logger.info('Forge observation has no run to attach a timeline row to', {
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
      sequence: 0,
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

function persistForgePrUrl(
  repository: AssistantThreadRepository | null,
  thread: AssistantMemoryThread,
  pullRequest: ForgePullRequest
): void {
  if (!(repository && thread.metadata?.forgePrUrl !== pullRequest.url)) {
    return;
  }
  repository
    .updateThreadMetadata(thread.id, { ...thread.metadata, forgePrUrl: pullRequest.url })
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
  readonly transition: ForgePrTransition;
}): void {
  const { event, matching, pullRequest, repository, transition } = input;
  const copy = describe(transition, pullRequest);
  for (const thread of matching) {
    appendTimelineRow({ copy, event, pullRequest, repository, thread, transition });
    persistForgePrUrl(repository, thread, pullRequest);
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
  branchLookup: ThreadBranchLookup
): readonly AssistantMemoryThread[] {
  return threads.filter((thread) => {
    const resolved = lookupThreadBranch(thread, branchLookup);
    return resolved?.branch === event.branch && resolved.gitCommonDir === event.repoCommonDir;
  });
}

function handleForgePrUpdated(event: ForgePrUpdatedEvent, args: UseForgeRunEventsArgs): void {
  const { assistantThreadRepository, branchLookup, notifications, threads } = args;
  const { pullRequest, transitions } = event;
  if (transitions.length === 0 || pullRequest === null) {
    return;
  }
  const matching = matchingThreads(event, threads, branchLookup);
  if (matching.length === 0) {
    return;
  }
  const observationKey = `${event.repoCommonDir} ${event.branch} ${pullRequest.headSha}`;
  for (const transition of transitions) {
    recordTransition({
      event,
      matching,
      pullRequest,
      repository: assistantThreadRepository,
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
 * The very first push may still arrive before that load resolves and go
 * unmatched; that is the SAME "eventually consistent, chip/pill still show
 * the PR" degrade already accepted for the no-run-timeline-row case above,
 * not a new exception. Deliberately NOT a shared cache across callers — that
 * is future work, not this task's.
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

export function useForgeRunEvents(args: UseForgeRunEventsArgs): void {
  const bridge = useMemo(() => resolveForgeBridge(), []);
  // The push handler must see the CURRENT threads/lookup without resubscribing
  // on every thread-store tick — a resubscribe would drop pushes in flight.
  const latest = useRef(args);
  latest.current = args;

  useEffect(() => {
    if (!bridge) {
      return;
    }
    return bridge.onPrUpdated((event: ForgePrUpdatedEvent) => {
      handleForgePrUpdated(event, latest.current);
    });
  }, [bridge]);
}
