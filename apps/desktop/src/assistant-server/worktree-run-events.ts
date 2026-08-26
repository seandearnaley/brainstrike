/**
 * Managed-worktree lifecycle timeline breadcrumbs (BST-1390): `worktree.created`,
 * `worktree.setup`, `worktree.archived`. Split out of `worktree-service.ts` to
 * keep that file under its line-count budget — the dependency shape
 * (`recordRunEvent`) and the emitted event shape are unchanged from what the
 * service used to build inline.
 *
 * All three are emitted `status: 'info'` (or `'failed'` for a failed setup),
 * never `'running'` — standalone breadcrumbs with no terminal to pair
 * against. See `docs/agents/assistant-persistence.md`,
 * "WORKTREE LIFECYCLE KINDS (BST-1390)".
 */
import path from 'node:path';
import {
  type AssistantRunEvent,
  type AssistantRunEventMetadata,
  createAssistantRunEvent,
} from '@brainstrike/agent';
import { createLogger } from '@brainstrike/logging';
import type { ManagedWorktreeRow, WorktreeSetupOutcome } from '@brainstrike/types';

const logger = createLogger('WorktreeRunEvents');

export interface WorktreeRunEventDeps {
  readonly recordRunEvent: (runId: string, event: AssistantRunEvent) => Promise<void>;
}

type WorktreeEventKind = 'worktree.archived' | 'worktree.created' | 'worktree.setup';

/**
 * A durable timeline row for an operation that happened INSIDE a run. With no
 * `runId` nothing is written — the same `if (runId)` gate every other
 * main-process run-event writer uses, not a fallback: `run_id` is `NOT NULL
 * REFERENCES brainstrike_assistant_thread_runs`, and the create sheet plus the
 * ledger already carry the fact for the no-run case.
 */
async function emit(
  deps: WorktreeRunEventDeps,
  runId: string | null | undefined,
  event: {
    readonly detail?: string;
    readonly kind: WorktreeEventKind;
    readonly label: string;
    readonly metadata: AssistantRunEventMetadata;
    readonly status: 'failed' | 'info';
  }
): Promise<void> {
  if (!runId) {
    return;
  }
  try {
    await deps.recordRunEvent(runId, createAssistantRunEvent({ ...event, runId }));
  } catch (error) {
    // A timeline row must never fail the operation it describes — but the
    // failure stays observable.
    logger.error('failed to record a worktree run event', { error, kind: event.kind, runId });
  }
}

/** `worktree.created`, plus `worktree.setup` when setup ran (status !== 'none'). */
export async function emitWorktreeCreateEvents(
  deps: WorktreeRunEventDeps,
  runId: string | null | undefined,
  worktree: ManagedWorktreeRow,
  setup: WorktreeSetupOutcome
): Promise<void> {
  await emit(deps, runId, {
    detail: worktree.branch ?? 'detached HEAD',
    kind: 'worktree.created',
    label: `Created worktree ${path.basename(worktree.path)}`,
    metadata: { branch: worktree.branch, path: worktree.path, worktreeId: worktree.id },
    status: 'info',
  });
  if (setup.status === 'none') {
    return;
  }
  await emit(deps, runId, {
    ...(setup.reason ? { detail: setup.reason } : {}),
    kind: 'worktree.setup',
    label: `Worktree setup ${setup.status}`,
    metadata: {
      copiedPaths: [...setup.copiedPaths],
      status: setup.status,
      truncated: setup.truncated,
      worktreeId: worktree.id,
    },
    status: setup.status === 'failed' ? 'failed' : 'info',
  });
}

export async function emitWorktreeArchivedEvent(
  deps: WorktreeRunEventDeps,
  runId: string | null | undefined,
  worktree: { readonly id: string; readonly path: string },
  snapshotRef: string
): Promise<void> {
  await emit(deps, runId, {
    detail: `Snapshot ${snapshotRef}`,
    kind: 'worktree.archived',
    label: `Archived worktree ${path.basename(worktree.path)}`,
    metadata: { path: worktree.path, snapshotRef, worktreeId: worktree.id },
    status: 'info',
  });
}
