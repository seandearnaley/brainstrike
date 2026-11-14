/**
 * What a `context.compacted` event says a compaction covers and why (ADR-0039,
 * BST-2527, BST-2531), without its run, its type and its usage receipt.
 */
import { Schema } from 'effect';
import { WorkspaceRelativePath } from './workspace-wire.ts';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
const Prompt = Schema.String;
const Seq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const HostContextCompactedFields = {
  /**
   * Every earlier run whose whole turn the summary covers: the ones this
   * compaction replaced and every one the summary it merged covered
   * (BST-2527). A branch reads one summary: its newest.
   */
  compactedRunIds: Schema.mutable(Schema.Array(Id)),
  /**
   * BST-2527: what the host wrote from the log for everything the
   * summary covers, with no model involved: the person's own request of
   * each whole turn (each cut at a fixed length), every file the covered
   * calls edited with its count of edits, and the tools they loaded.
   */
  earlierRequests: Schema.mutable(Schema.Array(Prompt)),
  filesEdited: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        edits: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
        path: WorkspaceRelativePath,
      })
    )
  ),
  kind: Schema.Literals(['agentic', 'deterministic']),
  modelId: Schema.optional(Id),
  /**
   * Before a request, after a provider's overflow, or the provider
   * request's own trim of a request still over its budget (BST-2531).
   */
  reason: Schema.Literals(['pre-request', 'context-overflow', 'request-trim']),
  /**
   * A deterministic fallback's reason: the agentic summarizer's typed
   * failure code, and the reference its cause is logged under (BST-2204).
   */
  summarizerFailure: Schema.optional(
    Schema.Struct({
      code: Id,
      correlationId: Schema.optional(Schema.String.check(Schema.isUUID())),
    })
  ),
  /**
   * The model's merged sections, or a fallback's line after the summary
   * it carried forward.
   */
  summary: Schema.String.check(Schema.isMinCodePoints(1)),
  /**
   * BST-2531: the steps of `runId` up to and including `stepNumber`
   * that the summary covers; the run's user message stays, and so do
   * the `kept` steps among them (a skill load, an `askUser` or
   * `submitPlan` result), word for word: every one any compaction of
   * the run kept (BST-2527).
   */
  through: Schema.optional(
    Schema.Struct({
      kept: Schema.optional(Schema.mutable(Schema.Array(Seq)).check(Schema.isMinLength(1))),
      runId: Id,
      stepNumber: Seq,
    }).check(
      Schema.makeFilter((through) =>
        (through.kept ?? []).every((step) => step < through.stepNumber)
          ? undefined
          : { issue: 'A kept step precedes the last step a compaction replaced', path: [] }
      )
    )
  ),
  toolsLoaded: Schema.mutable(Schema.Array(Id)),
};
