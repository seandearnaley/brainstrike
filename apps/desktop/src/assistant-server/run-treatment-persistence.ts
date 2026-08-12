import { createHash } from 'node:crypto';
import { createLogger } from '@brainstrike/logging';
import { getDatabase } from '../db-main';

const logger = createLogger('AssistantRunTreatment');

const ASSISTANT_RUN_TREATMENTS_TABLE = 'brainstrike_assistant_run_treatments';

/**
 * BST-1250 (recursive self-improvement phase 2A): the per-run treatment
 * record. Written at prompt assembly — the ONE seam that knows whether
 * self-improvement signal injection actually happened for this run and the
 * exact injected text. `signalContentHash` is the SHA-256 of that text (null
 * when nothing was injected); `experimentId`/`variant` come from the run's
 * experiment assignment and stay null for un-enrolled runs. Do NOT infer
 * treatment after the fact from date windows or the current preference value.
 */
export interface RunTreatmentInput {
  readonly experimentId: string | null;
  readonly resourceId: string;
  readonly runId: string;
  readonly signalContentHash: string | null;
  readonly signalInjected: boolean;
  readonly threadId: string;
  readonly variant: string | null;
}

export type RecordRunTreatment = (input: RunTreatmentInput) => Promise<void>;

/** SHA-256 hex of the exact injected system-message text. */
export function hashSignalContent(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

interface TreatmentDatabase {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
}

/**
 * Persist one treatment row (best-effort relative to the turn, never silent).
 * `ON CONFLICT DO NOTHING`: one treatment per run — a duplicate prompt
 * assembly for the same run must not rewrite the recorded treatment.
 */
export async function recordDesktopRunTreatment(
  input: RunTreatmentInput,
  getDatabaseProvider: () => Promise<TreatmentDatabase> = getDatabase
): Promise<void> {
  try {
    const database = await getDatabaseProvider();
    await database.query(
      `INSERT INTO ${ASSISTANT_RUN_TREATMENTS_TABLE}
        (run_id, thread_id, resource_id, experiment_id, variant, signal_injected, signal_content_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (run_id) DO NOTHING`,
      [
        input.runId,
        input.threadId,
        input.resourceId,
        input.experimentId,
        input.variant,
        input.signalInjected,
        input.signalContentHash,
      ]
    );
  } catch (error: unknown) {
    logger.warn('Failed to persist the run treatment record', {
      code: 'assistant_run_treatment_persist_failed',
      error: error instanceof Error ? error.message : String(error),
      runId: input.runId,
    });
  }
}
