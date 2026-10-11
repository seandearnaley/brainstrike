/**
 * Gap 10: the Threads panel's host search, its message and title arms and
 * the semantic arm's backlog. protocol.ts spreads each table into its own.
 */
import { z } from 'zod';

const Id = z.string().min(1);
const Seq = z.number().int().nonnegative();
const ThreadTitle = z.string().trim().min(1);

/** A host thread search match: the message the conversation renders (gap 10). */
export const HostSearchMessageSchema = z.strictObject({
  createdAt: z.number().int().nonnegative(),
  /** The matched text: each lexical match in `<mark>`, or a semantic match's opening text. */
  headline: z.string(),
  /** The id the conversation renders: the run's user message or its answer. */
  messageId: Id,
  role: z.enum(['assistant', 'user']),
  /** A child thread's root; a root's own id. */
  rootThreadId: Id,
  threadId: Id,
});
/** The caller's embedder identity; the state index validates and hashes it. */
const SearchVectorProfile = z.record(z.string(), z.json());
/** sha256 of the row text a vector was computed from. */
const SearchSourceHash = z.string().regex(/^[a-f0-9]{64}$/u);
const SearchSemantic = z.strictObject({
  profile: SearchVectorProfile,
  threshold: z.number().min(-1).max(1),
  vector: z.array(z.number()).min(1),
});

export const SEARCH_METHOD_SCHEMAS = {
  /** Gap 10: the host's message and title arms for the Threads panel's fused search. */
  'thread/search': z.strictObject({
    limit: z.number().int().positive().max(100).optional(),
    query: z.string().trim().min(1).max(500),
    /** The semantic arm: the caller's query vector, its embedder profile and minimum cosine. */
    semantic: SearchSemantic.optional(),
  }),
  /** The semantic arm's coverage of every host thread under the caller's embedder profile. */
  'thread/search/coverage': z.strictObject({ profile: SearchVectorProfile }),
  /** The semantic arm's backlog: rows with no vector under the caller's embedder profile. */
  'thread/search/pending': z.strictObject({
    limit: z.number().int().positive().max(64),
    profile: SearchVectorProfile,
  }),
  /**
   * The caller's vectors for backlog rows, each with the source hash it
   * embedded, or why it could not embed a row (legacy's `embedding_error`).
   */
  'thread/search/vectors': z.strictObject({
    profile: SearchVectorProfile,
    rows: z.array(
      z.union([
        z.strictObject({
          seq: Seq,
          sourceHash: SearchSourceHash,
          threadId: Id,
          vector: z.array(z.number()).min(1),
        }),
        z.strictObject({
          error: z.string().min(1),
          seq: Seq,
          sourceHash: SearchSourceHash,
          threadId: Id,
        }),
      ])
    ),
  }),
  'workspace/search': z.strictObject({
    limit: z.number().int().positive().max(200),
    mode: z.enum(['bm25', 'trigram']),
    query: z.string().trim().min(1),
    rootId: Id,
    threadId: Id,
  }),
} as const;

export const SEARCH_RESULT_SCHEMAS = {
  'thread/search': z.strictObject({
    /** Best match first; each on its thread's committed selected path. */
    messages: z.array(HostSearchMessageSchema),
    /** The semantic arm's matches, nearest first, as `messages` and with a text snippet. */
    similar: z.array(HostSearchMessageSchema),
    /** Root threads whose title holds every query word, most similar first. */
    titles: z.array(z.strictObject({ similarity: z.number(), threadId: Id, title: ThreadTitle })),
  }),
  /** Rows, rows with a vector, and rows whose last embedding failed within the retry window. */
  'thread/search/coverage': z.strictObject({
    embedded: z.number().int().nonnegative(),
    errored: z.number().int().nonnegative(),
    rows: z.number().int().nonnegative(),
  }),
  'thread/search/pending': z.strictObject({
    rows: z.array(
      z.strictObject({
        seq: Seq,
        sourceHash: SearchSourceHash,
        text: z.string().min(1),
        threadId: Id,
      })
    ),
  }),
  'thread/search/vectors': z.strictObject({
    failed: z.number().int().nonnegative(),
    stale: z.number().int().nonnegative(),
    stored: z.number().int().nonnegative(),
  }),
  'workspace/search': z.strictObject({
    candidateCount: Seq,
    candidatesTruncated: z.boolean(),
    hits: z.array(
      z.strictObject({
        chunkId: Id,
        content: z.string(),
        endLine: z.number().int().positive(),
        fileId: Id,
        path: Id,
        rootId: Id,
        score: z.number(),
        startLine: z.number().int().positive(),
      })
    ),
    scanLimited: z.boolean(),
    storeId: Id,
    truncated: z.boolean(),
  }),
} as const;
