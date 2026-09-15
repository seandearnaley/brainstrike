import {
  type DelegatedCancellationControl,
  type DelegatedCancellationTarget,
  type DelegatedDecisionControl,
  type DelegatedDecisionRequest,
  isLiveDecisionUnavailableError,
} from '@brainstrike/agent';
import type { DelegatedConversationDatabase, DelegatedConversationScope } from '@brainstrike/db';
import { z } from 'zod';
import { stopDesktopDelegatedCommandSessions } from './command-session-manager';

const controls = new Map<string, DelegatedCancellationControl>();

/** Process-local capability owned and removed by the actual native runtime. */
export function registerDesktopDelegatedCancellation(
  hostRunId: string,
  control: DelegatedCancellationControl
): () => void {
  if (controls.has(hostRunId)) {
    throw new Error('The host leg already owns delegated execution controls.');
  }
  controls.set(hostRunId, control);
  return () => {
    if (controls.get(hostRunId) === control) {
      controls.delete(hostRunId);
    }
  };
}

/** Receives only targets returned by revokeDelegatedConversationAdmission after
 * its owner/root-scoped DB update. The query below authorizes registered host
 * controls; its run IDs are not the already-authorized child thread IDs. */
export async function joinDesktopDelegatedCancellation(
  database: DelegatedConversationDatabase,
  scope: DelegatedConversationScope,
  targets: readonly (DelegatedCancellationTarget & { readonly threadId: string })[]
): Promise<void> {
  const registered = new Map(controls);
  if (registered.size === 0) {
    await stopDesktopDelegatedCommandSessions(targets.map((target) => target.threadId));
    return;
  }
  const rows = await database.query(
    `SELECT runs.id FROM brainstrike_assistant_thread_runs runs
     JOIN mastra_threads root ON root.id = runs.thread_id AND root."resourceId" = runs.resource_id
     WHERE runs.resource_id = $1 AND runs.thread_id = $2 AND runs.id IN (SELECT jsonb_array_elements_text($3::jsonb))`,
    [scope.ownerResourceId, scope.rootThreadId, JSON.stringify([...registered.keys()])]
  );
  const owners = z.array(z.object({ id: z.string() })).parse(rows.rows);
  const results = await Promise.allSettled(
    owners.map(({ id }) => {
      const control = registered.get(id);
      if (!control) {
        throw new Error('Cancellation returned an unregistered execution owner.');
      }
      return control(targets);
    })
  );
  const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  // Native cancellation first closes admission. Then join any persistent PTY
  // owned by those children before acknowledging selected Stop.
  try {
    await stopDesktopDelegatedCommandSessions(targets.map((target) => target.threadId));
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Selected delegated execution did not finish cancellation.');
  }
}

const decisionControls = new Map<string, DelegatedDecisionControl>();

/**
 * The running leg's live decision control (`registerDecisionControl`), keyed
 * by the host run id the renderer steers by (`registerSteerableRun`). One
 * control per leg, torn down with the runtime exactly like cancellation.
 */
export function registerDesktopDelegatedDecision(
  hostRunId: string,
  control: DelegatedDecisionControl
): () => void {
  if (decisionControls.has(hostRunId)) {
    throw new Error('The host leg already owns a live decision control.');
  }
  decisionControls.set(hostRunId, control);
  return () => {
    if (decisionControls.get(hostRunId) === control) {
      decisionControls.delete(hostRunId);
    }
  };
}

/**
 * Deliver a decision into the RUNNING leg `runId` (POST /assistant/decide).
 * `'no-live-run'` means the leg has no live control for it — it settled, or
 * the decision does not address a parked background child — and the caller
 * takes the ordinary new-leg path. Every other failure propagates: the host
 * refused the decision (a stale or duplicate answer) or the resume failed.
 */
export async function deliverDesktopDelegatedDecision(
  runId: string,
  request: DelegatedDecisionRequest
): Promise<'delivered' | 'no-live-run'> {
  const control = decisionControls.get(runId);
  if (!control) {
    return 'no-live-run';
  }
  try {
    await control(request);
  } catch (error) {
    if (isLiveDecisionUnavailableError(error)) {
      return 'no-live-run';
    }
    throw error;
  }
  return 'delivered';
}
