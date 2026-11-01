/**
 * The wire of `desktop-read/index/search`: Main's text index search for the
 * host's `workspace/search`, each side parsing what crosses.
 */
import { Schema } from 'effect';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const IndexSearchRequestSchema = Schema.Struct({
  limit: Schema.Int.check(Schema.isGreaterThan(0)),
  mode: Schema.Literals(['bm25', 'trigram']),
  rootIds: Schema.mutable(Schema.Array(Id)),
  text: Schema.String,
});
export const IndexSearchResultSchema = Schema.Struct({
  candidateCount: Count,
  candidatesTruncated: Schema.Boolean,
  hits: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        chunkId: Schema.String,
        content: Schema.String,
        endLine: Schema.Int,
        fileId: Schema.String,
        relativePath: Schema.NullOr(Schema.String),
        rootId: Schema.NullOr(Schema.String),
        score: Schema.Finite,
        startLine: Schema.Int,
      })
    )
  ),
  scanLimited: Schema.Boolean,
  storeId: Schema.String,
  truncated: Schema.Boolean,
});
/** Every index read names the admitted thread it serves. */
export function threadScoped<T extends Schema.ConstraintDecoder<unknown>>(request: T) {
  return Schema.Struct({ request, threadId: Id });
}
