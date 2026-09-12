import type { DelegatedCancellationControl, DelegatedCancellationTarget } from '@brainstrike/agent';
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

/** Called after durable revocation, so a later leg cannot admit the stopped invocation. */
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
