/**
 * A `context.compacted` event: what a compaction covers and why (ADR-0039,
 * BST-2527, BST-2531), and `thread/compact`, the compaction a person asks for
 * (BST-2536).
 */
import { Schema } from 'effect';
import type { JsonSchemaFactory } from './json-value.ts';
import { WorkspaceRelativePath } from './workspace-wire.ts';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
const Prompt = Schema.String;
const Seq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** BST-2536: the most a person writes for a compaction to keep, in code points. */
export const COMPACTION_FOCUS_MAX_CODE_POINTS = 500;
/** The person's own words for what a compaction they asked for should keep. */
const Focus = Schema.String.check(Schema.isPattern(/\S/u)).check(
  Schema.isMaxCodePoints(COMPACTION_FOCUS_MAX_CODE_POINTS)
);

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
  /** BST-2536: what the person asked a compaction they requested to keep, in their words. */
  focus: Schema.optional(Focus),
  kind: Schema.Literals(['agentic', 'deterministic']),
  modelId: Schema.optional(Id),
  /**
   * Before a request, after a provider's overflow, the provider request's
   * own trim of a request still over its budget (BST-2531), or because a
   * person asked for it between runs (`thread/compact`, BST-2536).
   */
  reason: Schema.Literals(['pre-request', 'context-overflow', 'request-trim', 'requested']),
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

/** The committed `context.compacted` event, with its run and the summary call's usage receipt. */
export function hostContextCompactedSchema(json: JsonSchemaFactory) {
  return Schema.Struct({
    runId: Id,
    type: Schema.Literal('context.compacted'),
    ...HostContextCompactedFields,
    usage: Schema.optional(json()),
  }).check(
    Schema.makeFilter((event) =>
      event.compactedRunIds.length > 0 || event.through !== undefined
        ? undefined
        : { issue: 'A compaction replaces at least one turn or step', path: [] }
    )
  );
}

export const COMPACTION_METHOD_SCHEMAS = {
  /**
   * BST-2536: compact the thread's branch now, between runs, with the
   * summary the thread's next request would ask for. The branch ends with
   * `parentMessageId`, the run the person's view ends with, as `run/start`
   * names it; absent, the run the thread's next message would follow.
   * Refused while a run is active or another compaction runs, while the
   * thread is rewound, when nothing is droppable, when the thread's model
   * cannot be admitted and when the summary fails; a refusal commits nothing.
   */
  'thread/compact': Schema.Struct({
    commandId: Id,
    focus: Schema.optional(Focus),
    parentMessageId: Schema.optional(Schema.NullOr(Id)),
    threadId: Id,
  }),
} as const;

export const COMPACTION_RESULT_SCHEMAS = {
  /** The committed compaction. */
  'thread/compact': hostContextCompactedSchema(() => Schema.MutableJson),
} as const;
