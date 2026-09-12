import { cancelSteerableRunAndWait } from '@brainstrike/assistant-service/steering';
import {
  createDelegatedConversationRepository,
  type DelegatedConversationDatabase,
  DelegatedConversationIdentityError,
  type DelegatedConversationScope,
} from '@brainstrike/db';
import { z } from 'zod';
import { continuationProjectionId } from './delegated-continuation-identity';

const owner = z.object({ hostRunId: z.string().min(1), id: z.string().min(1) });
/** Fence admission before joining the existing managed root owner for each selected wake. */
export async function cancelDelegatedContinuations(
  database: DelegatedConversationDatabase,
  scope: DelegatedConversationScope,
  threadId: string,
  includeDescendants: boolean
): Promise<void> {
  const node = await createDelegatedConversationRepository(database).get(scope, threadId);
  if (!node?.parentThreadId) {
    throw new DelegatedConversationIdentityError('continuation-cancel-owner-invalid');
  }
  const result = await database.query(
    `WITH RECURSIVE selected AS (
    SELECT thread_id FROM brainstrike_delegated_conversations WHERE thread_id = $3 AND owner_resource_id = $1 AND root_thread_id = $2
    UNION ALL SELECT child.thread_id FROM brainstrike_delegated_conversations child JOIN selected parent ON child.parent_thread_id = parent.thread_id
    WHERE child.owner_resource_id = $1 AND child.root_thread_id = $2 AND $4 = 1
  ) UPDATE brainstrike_delegated_continuations continuation SET cancellation_requested_at = COALESCE(cancellation_requested_at, NOW()), updated_at = NOW()
  FROM selected WHERE continuation.thread_id = selected.thread_id AND continuation.owner_resource_id = $1 AND continuation.root_thread_id = $2
    AND continuation.state IN ('claimed','running','awaiting-approval','awaiting-input')
  RETURNING continuation.id, continuation.active_host_run_id AS "hostRunId"`,
    [scope.ownerResourceId, scope.rootThreadId, threadId, includeDescendants ? 1 : 0]
  );
  const owners = z.array(owner).parse(result.rows);
  await Promise.all(owners.map(({ hostRunId }) => cancelSteerableRunAndWait(hostRunId)));
  if (owners.length === 0) {
    return;
  }
  await database.query(
    `WITH selected AS (
      SELECT * FROM jsonb_to_recordset($3::jsonb) AS entry(id text, "hostRunId" text, "projectionId" text)
    ), settled AS (
      UPDATE brainstrike_delegated_continuations continuation SET state = 'cancelled', updated_at = NOW()
      FROM selected WHERE continuation.id = selected.id AND continuation.active_host_run_id = selected."hostRunId"
        AND continuation.owner_resource_id = $1 AND continuation.root_thread_id = $2
        AND continuation.cancellation_requested_at IS NOT NULL
        AND continuation.state IN ('claimed','running','awaiting-approval','awaiting-input','cancelled')
      RETURNING continuation.*
    ), child_run AS (
      UPDATE brainstrike_assistant_thread_runs run SET status = 'cancelled', completed_at = NOW(), updated_at = NOW()
      FROM selected JOIN settled ON settled.id = selected.id
      JOIN brainstrike_delegated_conversations node ON node.thread_id = settled.thread_id
        AND node.root_thread_id = $2 AND node.owner_resource_id = $1
      WHERE run.id = selected."projectionId" AND run.thread_id = node.thread_id AND run.resource_id = node.resource_id
        AND run.status IN ('running','completed','awaiting-approval','awaiting-input') RETURNING run.*
    ) INSERT INTO brainstrike_assistant_run_events
      (id,run_id,resource_id,thread_id,sequence,kind,status,label,metadata,occurred_at,created_at,updated_at)
      SELECT run.id || ':cancelled',run.id,run.resource_id,run.thread_id,
        (SELECT COALESCE(MAX(event.sequence),-1)+1 FROM brainstrike_assistant_run_events event WHERE event.run_id=run.id),
        'run.cancelled','cancelled','Stopped',
        (SELECT event.metadata FROM brainstrike_assistant_run_events event WHERE event.run_id=run.id ORDER BY event.sequence DESC LIMIT 1),
        run.completed_at,NOW(),NOW() FROM child_run run ON CONFLICT(id) DO NOTHING`,
    [
      scope.ownerResourceId,
      scope.rootThreadId,
      JSON.stringify(
        owners.map((entry) => ({
          ...entry,
          projectionId: continuationProjectionId(entry.hostRunId, entry.id),
        }))
      ),
    ]
  );
}
