import { Schema } from 'effect';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const FileSearchMatchSchema = Schema.Struct({
  /** 1-based line number. */
  line: Schema.Int.check(Schema.isGreaterThan(0)),
  /** The matched line, cut to a bounded length for display. */
  lineText: Schema.String,
  /** Root-relative POSIX path, without a leading slash. */
  path: Schema.String.check(Schema.isMinCodePoints(1)),
  /** The live root the file belongs to, as the host's root registry names it. */
  rootId: Id,
});

/**
 * One batch of a running `workspace/files/search`'s matches, pushed only to the
 * connection that started it, as ripgrep finds them. No batch follows the
 * search's answer, nor its cancellation.
 */
export const FILE_SEARCH_BATCH = 'workspace/files/search/batch';
export const FileSearchBatchSchema = Schema.Struct({
  matches: Schema.Array(FileSearchMatchSchema),
  searchId: Id,
});
export type FileSearchBatch = (typeof FileSearchBatchSchema)['Type'];

/**
 * The Explorer's Search tab: a live text search of every live workspace root,
 * served by the host's ripgrep (ADR-0035). Only the desktop's private clients
 * reach it. Matches stream as `workspace/files/search/batch` batches; the answer
 * arrives once the search ends and names every cap it hit. Cancelling the
 * request ends ripgrep.
 */
export const FILE_SEARCH_METHOD_SCHEMAS = {
  'workspace/files/search': Schema.Struct({
    caseSensitive: Schema.Boolean,
    isRegex: Schema.Boolean,
    query: Schema.String.check(Schema.isMinCodePoints(1)),
    /** The client's name for this search, which its batches carry. */
    searchId: Id,
    wholeWord: Schema.Boolean,
  }),
} as const;
export const FILE_SEARCH_RESULT_SCHEMAS = {
  'workspace/files/search': Schema.Struct({
    /** The candidate-file cap or ripgrep's output cap ended the search early. */
    candidatesTruncated: Schema.Boolean,
    /** How many matches the batches carried. */
    matches: Count,
    /** The search stopped at its match cap. */
    matchLimitReached: Schema.Boolean,
    /** A regex with no literal ripgrep could prefilter on stopped at the file cap. */
    scanLimited: Schema.Boolean,
    /** ripgrep reached its time limit, so some files were not searched. */
    timedOut: Schema.Boolean,
    /** Live roots whose folder could not be read, so they were not searched. */
    unreadableRootIds: Schema.Array(Id),
  }),
} as const;
