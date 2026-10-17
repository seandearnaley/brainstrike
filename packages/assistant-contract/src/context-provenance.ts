import { Schema } from 'effect';
// --- Projection formats: the producer writes them, the fold reads them back ---
/** `1-50/61`, `1-50/61+` (a lower bound), or `empty@offset=50/61` for a page with nothing kept. */
export function formatGrepProjectionPageRange(args: {
  readonly kept: number;
  readonly lowerBound: boolean;
  readonly offset: number;
  readonly total: number;
}): string {
  const totalLabel = `${args.total}${args.lowerBound ? '+' : ''}`;
  if (args.kept === 0) {
    return `empty@offset=${args.offset}/${totalLabel}`;
  }
  return `${args.offset + 1}-${args.offset + args.kept}/${totalLabel}`;
}
const GREP_CONTENT_HEADER = /^grep content (?:(\d+)-(\d+)|empty@offset=(\d+))\/\d+\+?(?:\s|$)/u;
/**
 * The page a delivered grep content projection kept, from its first line, or
 * undefined when the text is not a grep content projection.
 */
export function parseGrepContentProjectionPage(text: string):
  | {
      readonly kept: number;
      readonly offset: number;
    }
  | undefined {
  const match = GREP_CONTENT_HEADER.exec(text);
  if (!match) {
    return;
  }
  if (match[3] !== undefined) {
    return { kept: 0, offset: Number(match[3]) };
  }
  const first = Number(match[1]);
  const last = Number(match[2]);
  return { kept: last - first + 1, offset: first - 1 };
}
/** The `shown=` field of a list projection that keeps the first `kept` of `total` items. */
export function formatProjectionShownCount(kept: number, total: number): string {
  return `shown=${kept}/${total}`;
}
/** The kept count from a delivered list projection's `shown=` field, or undefined. */
export function parseProjectionShownCount(text: string): number | undefined {
  const match = /(?:^|\s)shown=(\d+)\/\d+(?:\s|$)/u.exec(text.split('\n', 1)[0] ?? '');
  return match ? Number(match[1]) : undefined;
}
/** The marker a projection writes when it cut packed context text to fit. */
export const PROJECTION_OMITTED_CONTEXT_CHARS = 'projection_omitted_context_chars';
// --- Raw result fields, per tool -------------------------------------------
const Line = Schema.Int.check(Schema.isGreaterThan(0));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Text = Schema.String.check(Schema.isMinCodePoints(1));
/** readWorkspaceFile: the page it returned is exactly what the model received. */
export const ReadDeliverySchema = Schema.StructWithRest(
  Schema.Struct({
    approxOutputTokens: Count,
    content: Schema.String,
    dedup: Schema.optional(Schema.Boolean),
    endLine: Count,
    path: Text,
    rootId: Text,
    startLine: Line,
    totalLines: Count,
    truncated: Schema.Boolean,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
);
export type ReadDelivery = (typeof ReadDeliverySchema)['Type'];
const GrepMatchDeliverySchema = Schema.StructWithRest(
  Schema.Struct({
    after: Schema.mutable(Schema.Array(Schema.String)),
    before: Schema.mutable(Schema.Array(Schema.String)),
    line: Line,
    lineText: Schema.String,
    path: Text,
    rootId: Schema.optional(Schema.NullOr(Text)),
    rootName: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
);
/** grepSearch content mode: matches from `offset`; the projection may keep fewer. */
export const GrepContentDeliverySchema = Schema.StructWithRest(
  Schema.Struct({
    matches: Schema.mutable(Schema.Array(GrepMatchDeliverySchema)),
    offset: Count,
    outputMode: Schema.Literal('content'),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
);
export type GrepContentDelivery = (typeof GrepContentDeliverySchema)['Type'];
/** grepSearch files mode: paths only, no file content. */
export const GrepFilesDeliverySchema = Schema.StructWithRest(
  Schema.Struct({ outputMode: Schema.Literal('files') }),
  [Schema.Record(Schema.String, Schema.Unknown)]
);
/** queryEmbeddingSpace: packed chunks, whose text the projection may cut. */
export const SemanticDeliverySchema = Schema.StructWithRest(
  Schema.Struct({
    chunkContentIncludedInContext: Schema.Boolean,
    chunks: Schema.mutable(
      Schema.Array(
        Schema.StructWithRest(
          Schema.Struct({
            filePath: Schema.optional(Text),
            id: Text,
            lineRange: Schema.optional(
              Schema.StructWithRest(Schema.Struct({ end: Line, start: Line }), [
                Schema.Record(Schema.String, Schema.Unknown),
              ])
            ),
            metadata: Schema.optional(
              Schema.StructWithRest(
                Schema.Struct({
                  rootId: Schema.optional(Text),
                  rootName: Schema.optional(Schema.String),
                }),
                [Schema.Record(Schema.String, Schema.Unknown)]
              )
            ),
          }),
          [Schema.Record(Schema.String, Schema.Unknown)]
        )
      )
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
);
export type SemanticDelivery = (typeof SemanticDeliverySchema)['Type'];
/** hybridSearch: ranked chunks, each sent as a clipped excerpt; the projection may keep fewer. */
export const HybridDeliverySchema = Schema.StructWithRest(
  Schema.Struct({
    results: Schema.mutable(
      Schema.Array(
        Schema.StructWithRest(
          Schema.Struct({
            filePath: Schema.optional(Text),
            id: Text,
            rootName: Schema.optional(Schema.String),
          }),
          [Schema.Record(Schema.String, Schema.Unknown)]
        )
      )
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
);
export type HybridDelivery = (typeof HybridDeliverySchema)['Type'];
/** stringReplaceWorkspaceFile: the written range (absent on results recorded before it existed). */
export const StringReplaceDeliverySchema = Schema.StructWithRest(
  Schema.Struct({
    editedLines: Schema.optional(
      Schema.StructWithRest(Schema.Struct({ endLine: Line, startLine: Line }), [
        Schema.Record(Schema.String, Schema.Unknown),
      ])
    ),
    path: Text,
    rootId: Text,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
);
export type StringReplaceDelivery = (typeof StringReplaceDeliverySchema)['Type'];
/** writeWorkspaceFile: the whole file was written. */
export const WriteDeliverySchema = Schema.StructWithRest(
  Schema.Struct({ path: Text, rootId: Text }),
  [Schema.Record(Schema.String, Schema.Unknown)]
);
export type WriteDelivery = (typeof WriteDeliverySchema)['Type'];
