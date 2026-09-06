import type { ManageCanvasInput, RuntimeData } from '@brainstrike/agent';
import { CANVAS_HTML_MAX_BYTES, NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import {
  applyUpdate,
  type CanvasDatabase,
  type CanvasListResult,
  type CanvasMutationResult,
  createCanvas,
  listCanvasesForThread,
  rewriteCanvas,
} from './canvas-repository';

export type { CanvasDatabase } from './canvas-repository';

export const MANAGE_CANVAS_TOOL_ID = NATIVE_TOOL_ID.manageCanvas;

const logger = createLogger('AssistantCanvas');

export interface ManageCanvasDependencies {
  /** Injected DB handle for tests; production resolves the main-process handle. */
  database?: CanvasDatabase;
}

async function resolveDesktopDatabase(): Promise<CanvasDatabase> {
  const { getDatabase } = await import('../db-main');
  return getDatabase();
}

/**
 * Closed failure vocabulary: the tool adds exactly one failure of its own
 * (`no_active_thread`) on top of the repository's — consumers narrowing on
 * `result.error` keep exhaustiveness checking.
 */
export interface ManageCanvasNoThreadFailure {
  readonly error: 'no_active_thread';
  readonly hint: string;
  readonly ok: false;
}

/**
 * The repository's `too_large`, carrying the recovery the model needs. Declared
 * here rather than in the repository because the hint is tool-facing prose, the
 * same reason `no_active_thread` lives here.
 */
export interface ManageCanvasTooLargeFailure {
  readonly error: 'too_large';
  readonly hint: string;
  readonly ok: false;
}

export type ManageCanvasToolResult =
  | CanvasListResult
  | CanvasMutationResult
  | ManageCanvasNoThreadFailure
  | ManageCanvasTooLargeFailure;

/**
 * `too_large` is the one repository failure a model cannot recover from by
 * retrying — the same edit fails identically forever — so it is the one that has
 * to arrive with instructions. Every other member of the union either describes
 * a state the model can inspect (`no_match`, `ambiguous_match`, `not_found`) or
 * is genuinely retryable (`version_conflict`).
 */
function withSizeHint(result: CanvasMutationResult): ManageCanvasToolResult {
  return 'ok' in result && result.ok === false && result.error === 'too_large'
    ? {
        error: 'too_large',
        hint: `The document would exceed the ${CANVAS_HTML_MAX_BYTES / 1_000_000} MB canvas limit, measured in UTF-8 bytes. Retrying unchanged will fail the same way: send a smaller replacement, or start a new canvas.`,
        ok: false,
      }
    : result;
}

export async function runManageCanvas(
  input: ManageCanvasInput,
  runtimeData: RuntimeData | undefined,
  dependencies: ManageCanvasDependencies = {}
): Promise<ManageCanvasToolResult> {
  const threadId = runtimeData?.memory?.threadId;
  const resourceId = runtimeData?.memory?.resourceId;
  if (!(threadId && resourceId)) {
    logger.warn('manageCanvas called without an active memory thread');
    return {
      error: 'no_active_thread',
      hint: 'manageCanvas requires an active memory thread.',
      ok: false,
    };
  }

  const db = dependencies.database ?? (await resolveDesktopDatabase());
  switch (input.action) {
    case 'create':
      return withSizeHint(
        await createCanvas(db, {
          createdBy: 'assistant',
          html: input.html,
          resourceId,
          threadId,
          title: input.title,
        })
      );
    case 'update':
      // threadId comes from runtime memory, NEVER from model input: mutations
      // are hard-scoped to the calling thread (cross-thread ids resolve to the
      // same uniform not_found as nonexistent ids).
      return withSizeHint(await applyUpdate(db, { ...input, threadId }));
    case 'rewrite':
      return withSizeHint(await rewriteCanvas(db, { ...input, threadId }));
    case 'list':
      return await listCanvasesForThread(db, threadId);
  }
}
