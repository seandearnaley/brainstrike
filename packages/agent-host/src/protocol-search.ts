import { Schema } from 'effect';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
const Seq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const ThreadTitle = Schema.String.pipe(Schema.decodeTo(Schema.Trim)).check(
  Schema.isMinCodePoints(1)
);
/** A host thread search match: the message the conversation renders (gap 10). */
export const HostSearchMessageSchema = Schema.Struct({
  createdAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  headline: Schema.String,
  messageId: Id,
  role: Schema.Literals(['assistant', 'user']),
  rootThreadId: Id,
  threadId: Id,
});
/**
 * BST-1939: one root thread in the fused list. Messages fuse their lexical and
 * semantic ranks; threads fuse their best message's rank with their title's,
 * each by reciprocal rank (k = 60).
 */
const HostSearchResultSchema = Schema.Struct({
  matches: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        ...HostSearchMessageSchema.fields,
        ...{
          score: Schema.Finite.check(Schema.isGreaterThan(0)),
          sources: Schema.mutable(Schema.Array(Schema.Literals(['lexical', 'semantic']))).check(
            Schema.isMinLength(1)
          ),
        },
      })
    )
  ),
  score: Schema.Finite.check(Schema.isGreaterThan(0)),
  threadId: Id,
  title: Schema.optional(ThreadTitle),
  titleMatched: Schema.Boolean,
});
/** The caller's embedder identity; the state index validates and hashes it. */
const SearchVectorProfile = Schema.Record(Schema.String, Schema.MutableJson);
/** sha256 of the row text a vector was computed from. */
const SearchSourceHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const SearchTime = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const SearchSemantic = Schema.Struct({
  profile: SearchVectorProfile,
  threshold: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(-1)).check(
    Schema.isLessThanOrEqualTo(1)
  ),
  vector: Schema.mutable(Schema.Array(Schema.Finite)).check(Schema.isMinLength(1)),
});
export const SEARCH_METHOD_SCHEMAS = {
  /** Gap 10: the host's message and title arms for the Threads panel's fused search. */
  'thread/search': Schema.Struct({
    limit: Schema.optional(
      Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(100))
    ),
    query: Schema.String.pipe(Schema.decodeTo(Schema.Trim))
      .check(Schema.isMinCodePoints(1))
      .check(Schema.isMaxCodePoints(500)),
    rootId: Schema.optional(Id),
    semantic: Schema.optional(SearchSemantic),
    since: Schema.optional(SearchTime),
    until: Schema.optional(SearchTime),
  }).check(
    Schema.makeFilter(({ since, until }) =>
      since === undefined || until === undefined || since <= until
        ? undefined
        : { issue: 'A thread search window ends before it starts', path: [] }
    )
  ),
  /** The semantic arm's coverage of every host thread under the caller's embedder profile. */
  'thread/search/coverage': Schema.Struct({ profile: SearchVectorProfile }),
  /** The semantic arm's backlog: rows with no vector under the caller's embedder profile. */
  'thread/search/pending': Schema.Struct({
    limit: Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(64)),
    profile: SearchVectorProfile,
  }),
  /**
   * The caller's vectors for backlog rows, each with the source hash it
   * embedded, or why it could not embed a row (legacy's `embedding_error`).
   */
  'thread/search/vectors': Schema.Struct({
    profile: SearchVectorProfile,
    rows: Schema.mutable(
      Schema.Array(
        Schema.Union([
          Schema.Struct({
            seq: Seq,
            sourceHash: SearchSourceHash,
            threadId: Id,
            vector: Schema.mutable(Schema.Array(Schema.Finite)).check(Schema.isMinLength(1)),
          }),
          Schema.Struct({
            error: Schema.String.check(Schema.isMinCodePoints(1)),
            seq: Seq,
            sourceHash: SearchSourceHash,
            threadId: Id,
          }),
        ])
      )
    ),
  }),
  'workspace/search': Schema.Struct({
    limit: Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(200)),
    mode: Schema.Literals(['bm25', 'trigram']),
    query: Schema.String.pipe(Schema.decodeTo(Schema.Trim)).check(Schema.isMinCodePoints(1)),
    rootId: Id,
    threadId: Id,
  }),
} as const;
export const SEARCH_RESULT_SCHEMAS = {
  'thread/search': Schema.Struct({
    lexical: Schema.Literals(['all-words', 'any-word']),
    messages: Schema.mutable(Schema.Array(HostSearchMessageSchema)),
    results: Schema.mutable(Schema.Array(HostSearchResultSchema)),
    similar: Schema.mutable(Schema.Array(HostSearchMessageSchema)),
    titles: Schema.mutable(
      Schema.Array(Schema.Struct({ similarity: Schema.Finite, threadId: Id, title: ThreadTitle }))
    ),
  }),
  /** Rows, rows with a vector, and rows whose last embedding failed within the retry window. */
  'thread/search/coverage': Schema.Struct({
    embedded: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    errored: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    rows: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  'thread/search/pending': Schema.Struct({
    rows: Schema.mutable(
      Schema.Array(
        Schema.Struct({
          seq: Seq,
          sourceHash: SearchSourceHash,
          text: Schema.String.check(Schema.isMinCodePoints(1)),
          threadId: Id,
        })
      )
    ),
  }),
  'thread/search/vectors': Schema.Struct({
    failed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    stale: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    stored: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  'workspace/search': Schema.Struct({
    candidateCount: Seq,
    candidatesTruncated: Schema.Boolean,
    hits: Schema.mutable(
      Schema.Array(
        Schema.Struct({
          chunkId: Id,
          content: Schema.String,
          endLine: Schema.Int.check(Schema.isGreaterThan(0)),
          fileId: Id,
          path: Id,
          rootId: Id,
          score: Schema.Finite,
          startLine: Schema.Int.check(Schema.isGreaterThan(0)),
        })
      )
    ),
    scanLimited: Schema.Boolean,
    storeId: Id,
    truncated: Schema.Boolean,
  }),
} as const;
