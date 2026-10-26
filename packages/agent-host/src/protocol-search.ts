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
/** Root threads fuse their best message's rank with their title's (k = 60). */
const HostSearchResultSchema = Schema.Struct({
  matches: Schema.mutable(Schema.Array(HostSearchMessageSchema)),
  score: Schema.Finite.check(Schema.isGreaterThan(0)),
  threadId: Id,
  title: Schema.optional(ThreadTitle),
  titleMatched: Schema.Boolean,
});
const SearchTime = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
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
    since: Schema.optional(SearchTime),
    until: Schema.optional(SearchTime),
  }).check(
    Schema.makeFilter(({ since, until }) =>
      since === undefined || until === undefined || since <= until
        ? undefined
        : { issue: 'A thread search window ends before it starts', path: [] }
    )
  ),
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
    titles: Schema.mutable(
      Schema.Array(Schema.Struct({ similarity: Schema.Finite, threadId: Id, title: ThreadTitle }))
    ),
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
