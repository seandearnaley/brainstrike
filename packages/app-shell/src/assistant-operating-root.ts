import type { DbHandle } from '@brainstrike/db';

export interface AssistantOperatingRootCandidate {
  readonly displayName: string;
  readonly path: string;
}

export interface PersistedAssistantOperatingRootBinding {
  readonly displayName: string;
  readonly path: string;
  readonly rootId: string;
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
    throw new Error(
      `Cannot bind assistant thread to "${candidate.displayName}": the mounted folder has no unique live workspace identity.`
    );
  }
  return {
    displayName: candidate.displayName,
    path: candidate.path,
    rootId: result.rows[0].id,
  };
}
