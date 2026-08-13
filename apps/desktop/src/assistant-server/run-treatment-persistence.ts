import { createHash } from 'node:crypto';
import type { RuntimeData } from '@brainstrike/agent';
import { createLogger } from '@brainstrike/logging';
import { getDatabase } from '../db-main';

const logger = createLogger('AssistantRunTreatment');

const ASSISTANT_RUN_TREATMENTS_TABLE = 'brainstrike_assistant_run_treatments';

/**
 * BST-1250 review: `signal_injected = false` alone conflated three states —
 * preference off, a failed/malformed signal query, and a genuine no-waste
 * hour — and for an ENROLLED run "assigned to treatment but the signal was
 * unavailable" must never masquerade as a control run — and neither may a
 * MALFORMED preference ('preference_malformed'): a corrupt or version-skewed
 * request is not clean control evidence (Codex review). The status carries
 * the reason; `signal_injected` is derived (`status === 'injected'`).
 * `continuation` marks approval/resume legs, which mint their own runId but
 * never reach prompt assembly.
 */
export const RUN_INJECTION_STATUSES = [
  'continuation',
  'injected',
  'no_waste',
  'preference_malformed',
  'preference_off',
  'query_failed',
] as const;
export type RunInjectionStatus = (typeof RUN_INJECTION_STATUSES)[number];

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
  readonly injectionStatus: RunInjectionStatus;
  readonly resourceId: string;
  readonly runId: string;
  readonly signalContentHash: string | null;
  readonly threadId: string;
  readonly variant: string | null;
}

export type RecordRunTreatment = (input: RunTreatmentInput) => Promise<void>;

export interface NormalizedExperimentAssignment {
  readonly experimentId: string | null;
  readonly variant: string | null;
}

/**
 * BST-1250: strictly parse the renderer's experiment enrollment. Malformed
 * values warn and are treated as un-enrolled — never coerced (both fields
 * must be non-empty strings together; the wire type requires both, this parse
 * is the untrusted-wire guard behind it).
 */
export function readExperimentAssignment(
  runtimeData: RuntimeData | undefined
): NormalizedExperimentAssignment {
  const raw: unknown = runtimeData?.experimentAssignment;
  if (raw === undefined) {
    return { experimentId: null, variant: null };
  }
  if (raw === null || typeof raw !== 'object') {
    logger.warn('Ignoring malformed experimentAssignment (not an object)', {
      received: raw === null ? 'null' : typeof raw,
    });
    return { experimentId: null, variant: null };
  }
  const experimentId = (raw as Record<string, unknown>)['experimentId'];
  const variant = (raw as Record<string, unknown>)['variant'];
  if (
    !(
      typeof experimentId === 'string' &&
      experimentId.length > 0 &&
      typeof variant === 'string' &&
      variant.length > 0
    )
  ) {
    logger.warn('Ignoring malformed experimentAssignment; treating the run as un-enrolled', {
      experimentIdType: typeof experimentId,
      variantType: typeof variant,
    });
    return { experimentId: null, variant: null };
  }
  return { experimentId, variant };
}

/** SHA-256 hex of the exact injected system-message text. */
export function hashSignalContent(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

interface TreatmentDatabase {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
}

/**
 * Persist one treatment row. Best-effort AND detached relative to the turn:
 * callers fire it with `void` so prompt assembly never blocks on the
 * single-connection PGlite; failures log, never silently.
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
        (run_id, thread_id, resource_id, experiment_id, variant, injection_status, signal_injected, signal_content_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (run_id) DO NOTHING`,
      [
        input.runId,
        input.threadId,
        input.resourceId,
        input.experimentId,
        input.variant,
        input.injectionStatus,
        input.injectionStatus === 'injected',
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

/**
 * BST-1250 review: approval/resume continuation legs mint their own runId and
 * run row but return before prompt assembly, so they would carry outcome
 * labels with no treatment row — and they are NOT a random sample (they
 * correlate with tool-heavy, permission-gated runs). Recorded here with
 * status 'continuation'; wired into the stream-init early returns via the
 * optional `runPersistence.recordContinuationRunTreatment` capability.
 * Fire-and-forget by design.
 */
export function recordDesktopContinuationRunTreatment(runtimeData: RuntimeData | undefined): void {
  const memory = runtimeData?.memory;
  const runId = memory?.runId;
  if (!(memory && typeof runId === 'string' && runId.length > 0)) {
    logger.debug('continuation_treatment_skipped_no_run_id');
    return;
  }
  const assignment = readExperimentAssignment(runtimeData);
  void recordDesktopRunTreatment({
    experimentId: assignment.experimentId,
    injectionStatus: 'continuation',
    resourceId: memory.resourceId,
    runId,
    signalContentHash: null,
    threadId: memory.threadId,
    variant: assignment.variant,
  });
}
