import type { ManageCanvasInput } from '@brainstrike/agent';
import { CANVAS_HTML_MAX_BYTES, NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import { isEmptyCanvasDocument } from './canvas-document-content.js';
import type {
  CanvasListResult,
  CanvasMutationResult,
  CanvasRepositoryFailure,
  CanvasStore,
  CanvasVersion,
} from './ports.js';

export const MANAGE_CANVAS_TOOL_ID = NATIVE_TOOL_ID.manageCanvas;

const logger = createLogger('AssistantCanvas');

/**
 * Closed failure vocabulary: the tool adds exactly one failure of its own
 * (`no_active_thread`) on top of the store's — consumers narrowing on
 * `result.error` keep exhaustiveness checking.
 */
export interface ManageCanvasNoThreadFailure {
  readonly error: 'no_active_thread';
  readonly hint: string;
  readonly ok: false;
}

/**
 * The store's `too_large`, carrying the recovery the model needs. Declared
 * here rather than in the store because the hint is tool-facing prose, the
 * same reason `no_active_thread` lives here.
 */
export interface ManageCanvasTooLargeFailure {
  readonly error: 'too_large';
  readonly hint: string;
  readonly ok: false;
}

/**
 * A `create` whose document is empty (see `isEmptyCanvasDocument`). Tool-level
 * because it is policy about WHEN to create, not storage: a store happily
 * keeps an empty version 1, and `rewrite` may still produce one.
 * Live-app verifier runs 6 and 7 (2026-09-15): the root created a shell 25 s
 * into the turn and wrote the report behind a second approval; the user
 * reads card → approve → document appears, and the empty pre-create breaks
 * that reading.
 */
export interface ManageCanvasEmptyDocumentFailure {
  readonly error: 'empty_document';
  readonly hint: string;
  readonly ok: false;
}

export const EMPTY_CANVAS_DOCUMENT_HINT =
  'Nothing was created: the document has no content. Create the canvas when the content is ready — there is nothing to prepare. One create call carrying the finished document is the deliverable, and the only approval the user should see for it.';

/**
 * `too_large` is deliberately EXCLUDED from the store shape here and
 * re-admitted only in its hinted form, so a future call site cannot return the
 * bare code and silently drop the recovery the model depends on.
 */
export type ManageCanvasToolResult =
  | CanvasListResult
  | Exclude<CanvasMutationResult, { readonly error: 'too_large' }>
  | ManageCanvasEmptyDocumentFailure
  | ManageCanvasNoThreadFailure
  | ManageCanvasTooLargeFailure;

/**
 * `too_large` is the one store failure a model cannot recover from by
 * retrying — the same edit fails identically forever — so it is the one that has
 * to arrive with instructions. Every other member of the union either describes
 * a state the model can inspect (`no_match`, `ambiguous_match`, `not_found`) or
 * is genuinely retryable (`version_conflict`).
 */
function withSizeHint(result: CanvasMutationResult): ManageCanvasToolResult {
  return 'ok' in result && result.ok === false && result.error === 'too_large'
    ? {
        error: 'too_large',
        hint: `The document would exceed the ${CANVAS_HTML_MAX_BYTES / 1_000_000} MB canvas limit, measured in UTF-8 bytes rather than characters. Retrying the same edit fails identically. Send a smaller replacement, or use the rewrite action to replace the whole document — rewrite is the deterministic escape, because it does not compose against the stored version.`,
        ok: false,
      }
    : result;
}

/** One unique `oldString` match in the latest version, replaced; the store enforces the ceiling. */
export function applyCanvasUpdate(
  latest: CanvasVersion,
  oldString: string,
  newString: string
): string | CanvasRepositoryFailure {
  const firstMatch = latest.html.indexOf(oldString);
  if (firstMatch === -1) {
    return { error: 'no_match', ok: false };
  }
  const secondMatch = latest.html.indexOf(oldString, firstMatch + 1);
  if (secondMatch !== -1) {
    return { error: 'ambiguous_match', ok: false };
  }
  // Reject the clearly-oversized composition BEFORE materialising it. UTF-8
  // bytes >= UTF-16 units, so a unit count over the ceiling is over it in bytes
  // too — sparing a ~14 MB intermediate on exactly the hostile path the byte
  // predicate goes to some length not to allocate for. Anything below this
  // bound still gets the store's exact check.
  if (latest.html.length - oldString.length + newString.length > CANVAS_HTML_MAX_BYTES) {
    return { error: 'too_large', ok: false };
  }
  return `${latest.html.slice(0, firstMatch)}${newString}${latest.html.slice(
    firstMatch + oldString.length
  )}`;
}

/**
 * Canvas mutations are hard-scoped to the calling thread by its store: a canvas
 * of another thread resolves to the same uniform `not_found` as a missing one.
 */
export async function runManageCanvas(
  input: ManageCanvasInput,
  store: CanvasStore | undefined
): Promise<ManageCanvasToolResult> {
  if (!store) {
    logger.warn('manageCanvas called without an active memory thread');
    return {
      error: 'no_active_thread',
      hint: 'manageCanvas requires an active memory thread.',
      ok: false,
    };
  }
  switch (input.action) {
    case 'create':
      // Refused BEFORE any store call: an empty version 1 must never exist, and
      // the refusal must cost the model no approval.
      if (isEmptyCanvasDocument(input.html)) {
        logger.info('manageCanvas create refused: empty document');
        return { error: 'empty_document', hint: EMPTY_CANVAS_DOCUMENT_HINT, ok: false };
      }
      return withSizeHint(
        await store.create({ createdBy: 'assistant', html: input.html, title: input.title })
      );
    case 'update':
      return withSizeHint(
        await store.revise(input.canvasId, (latest) =>
          applyCanvasUpdate(latest, input.oldString, input.newString)
        )
      );
    case 'rewrite':
      return withSizeHint(await store.revise(input.canvasId, () => input.html));
    case 'list':
      return await store.list();
    default:
      throw new Error('Unknown manageCanvas action');
  }
}
