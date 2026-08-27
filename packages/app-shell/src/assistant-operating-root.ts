import type { DbHandle } from '@brainstrike/db/react';

export interface AssistantOperatingRootCandidate {
  readonly displayName: string;
  readonly path: string;
}

export interface PersistedAssistantOperatingRootBinding {
  readonly displayName: string;
  readonly path: string;
  readonly rootId: string;
}

/**
 * The AUTHORITATIVE "this path has no unique live `roots` row right now"
 * result — as opposed to `database.query` itself rejecting (a transient I/O
 * failure, connection issue, etc.), which tells you nothing about whether the
 * row exists. Callers that decide "wait for a registration event" vs. "this
 * needs a retry / must fail loud now" (`use-workspace-bar.ts`'s
 * `tryResolveRootId`) need this distinction as a TYPE, not a string-message
 * sniff: only THIS error means "no row (yet)"; anything else propagating from
 * `database.query` is a query failure that a future registration event will
 * never resolve.
 */
export class AssistantOperatingRootRowNotFoundError extends Error {
  constructor(displayName: string) {
    super(
      `Cannot bind assistant thread to "${displayName}": the mounted folder has no unique live workspace identity.`
    );
    this.name = 'AssistantOperatingRootRowNotFoundError';
  }
}

export async function resolveAssistantOperatingRootBinding(
  database: DbHandle,
  candidate: AssistantOperatingRootCandidate
): Promise<PersistedAssistantOperatingRootBinding> {
  const result = await database.query<{ id: string }>(
    `SELECT id
       FROM roots
      WHERE path = $1
        AND status = 'live'
      ORDER BY created_at ASC
      LIMIT 2`,
    [candidate.path]
  );
  if (result.rows.length !== 1 || !result.rows[0]?.id) {
    throw new AssistantOperatingRootRowNotFoundError(candidate.displayName);
  }
  return {
    displayName: candidate.displayName,
    path: candidate.path,
    rootId: result.rows[0].id,
  };
}
