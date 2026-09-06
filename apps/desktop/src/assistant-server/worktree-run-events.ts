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

interface WorktreeEventPayload {
  readonly detail?: string;
  readonly label: string;
  readonly metadata: AssistantRunEventMetadata;
  readonly status: 'failed' | 'info';
}

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
  kind: WorktreeEventKind,
  buildPayload: () => WorktreeEventPayload
): Promise<void> {
  if (!runId) {
    return;
  }
  try {
    const event = { ...buildPayload(), kind };
    await deps.recordRunEvent(runId, createAssistantRunEvent({ ...event, runId }));
  } catch (error) {
    // A timeline row must never fail the operation it describes — but the
    // failure stays observable.
    logger.error('failed to record a worktree run event', { error, kind, runId });
  }
}

/** `worktree.created` for a worktree BrainStrike did not create but now manages. */
export async function emitWorktreeAdoptedEvent(
  deps: WorktreeRunEventDeps,
  runId: string | null | undefined,
  worktree: ManagedWorktreeRow
): Promise<void> {
  await emit(deps, runId, 'worktree.created', () => ({
    detail: worktree.branch ?? 'detached HEAD',
    label: `Adopted worktree ${path.basename(worktree.path)}`,
    metadata: {
      branch: worktree.branch,
      path: worktree.path,
      via: 'adopt',
      worktreeId: worktree.id,
    },
    status: 'info',
  }));
}

/** `worktree.created` for a worktree the AGENT made in a shell (spec §6.4). */
export async function emitWorktreeShellCreatedEvent(
  deps: WorktreeRunEventDeps,
  runId: string | null | undefined,
  worktree: ManagedWorktreeRow
): Promise<void> {
  await emit(deps, runId, 'worktree.created', () => ({
    detail: worktree.branch ?? 'detached HEAD',
    // "via shell" in the label, not just the metadata: the timeline must say
    // out loud that BrainStrike did not perform this operation, it observed it.
    label: `Agent created worktree ${path.basename(worktree.path)} (via shell)`,
    metadata: {
      branch: worktree.branch,
      path: worktree.path,
      via: 'shell',
      worktreeId: worktree.id,
    },
    status: 'info',
  }));
}

/**
 * `worktree.created`, plus `worktree.setup` when setup ran (status !== 'none').
 * Serves BOTH ledger-backed create call sites; the row's `createdBy` — bound
 * at each call site (`'user'` from the Mode chip's IPC handler, `'agent'`
 * from the `manageWorktree` tool executor) — selects the `via` breadcrumb, so
 * the timeline and the ledger can never disagree about who created it.
 */
export async function emitWorktreeCreateEvents(
  deps: WorktreeRunEventDeps,
  runId: string | null | undefined,
  worktree: ManagedWorktreeRow,
  setup: WorktreeSetupOutcome
): Promise<void> {
  await emit(deps, runId, 'worktree.created', () => ({
    detail: worktree.branch ?? 'detached HEAD',
    label: `Created worktree ${path.basename(worktree.path)}`,
    metadata: {
      branch: worktree.branch,
      path: worktree.path,
      via: worktree.createdBy === 'agent' ? 'tool' : 'app',
      worktreeId: worktree.id,
    },
    status: 'info',
  }));
  if (setup.status === 'none') {
    return;
  }
  await emit(deps, runId, 'worktree.setup', () => ({
    ...(setup.reason ? { detail: setup.reason } : {}),
    label: `Worktree setup ${setup.status}`,
    metadata: {
      copiedPaths: [...setup.copiedPaths],
      status: setup.status,
      truncated: setup.truncated,
      worktreeId: worktree.id,
    },
    status: setup.status === 'failed' ? 'failed' : 'info',
  }));
}

export async function emitWorktreeArchivedEvent(
  deps: WorktreeRunEventDeps,
  runId: string | null | undefined,
  worktree: { readonly id: string; readonly path: string },
  snapshotRef: string
): Promise<void> {
  await emit(deps, runId, 'worktree.archived', () => ({
    detail: `Snapshot ${snapshotRef}`,
    label: `Archived worktree ${path.basename(worktree.path)}`,
    metadata: { path: worktree.path, snapshotRef, worktreeId: worktree.id },
    status: 'info',
  }));
}
