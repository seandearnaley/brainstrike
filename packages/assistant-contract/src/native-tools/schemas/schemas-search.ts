import { Schema } from 'effect';

const WORKSPACE_SEARCH_ROOT_DESCRIPTION =
  'Open-folder name/id. Omit for the thread-bound folder; an unbound request searches all open folders. To cover every folder in a bound thread, call once per root id. Results include their root.';

/** grep and glob without a root search every thread folder (BST-1990, D3). */
const GREP_GLOB_ROOT_DESCRIPTION =
  "Open-folder name/id. Omit to search all of this thread's folders. Results include their root.";

// Zod 4.6.7 counts string bounds in code points; preserve that pin's behavior.
const bounded = (minimum: number, maximum: number, description?: string) =>
  Schema.String.annotate({ description }).check(
    Schema.isMinCodePoints(minimum),
    Schema.isMaxCodePoints(maximum)
  );
const nonempty = (description?: string) =>
  Schema.String.annotate({ description }).check(Schema.isMinCodePoints(1));
const positiveInt = (maximum: number, description?: string) =>
  Schema.Int.annotate({ description }).check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(maximum)
  );
const range = (maximum: number, description?: string) =>
  Schema.Finite.annotate({ description }).check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(maximum)
  );
const offset = (maximum: number, description?: string) =>
  Schema.Int.annotate({ description }).check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(maximum)
  );

export const HybridSearchInputSchema = Schema.Struct({
  chunkType: Schema.optionalKey(
    Schema.Literals(['text', 'code', 'sentence', 'recursive']).annotate({
      description: 'Filter by chunk type',
    })
  ),
  embeddingSetId: Schema.optionalKey(
    nonempty('Embedding set ID for vector search; omit to use the Workspace Index')
  ),
  // Matches the repositories' MAX_INLINE_FILE_PATHS in both search arms.
  filePaths: Schema.optionalKey(
    Schema.Array(nonempty())
      .check(Schema.isMaxLength(500))
      .annotate({ description: 'Filter to specific file paths (max 500)' })
  ),
  ftsWeight: Schema.optionalKey(range(2, 'Weight for full-text search (default 1.0)')),
  limit: Schema.optionalKey(positiveInt(100, 'Maximum results to return')),
  query: bounded(1, 2000, 'Search query text'),
  root: Schema.optionalKey(nonempty(WORKSPACE_SEARCH_ROOT_DESCRIPTION)),
  vectorThreshold: Schema.optionalKey(range(1, 'Minimum similarity threshold')),
  vectorWeight: Schema.optionalKey(range(2, 'Weight for vector search (default 1.0)')),
});
export type HybridSearchInput = typeof HybridSearchInputSchema.Type;

export const QueryFileTreeInputSchema = Schema.Struct({
  includeHidden: Schema.optionalKey(
    Schema.Boolean.annotate({ description: 'Include hidden files/directories' })
  ),
  maxDepth: Schema.optionalKey(positiveInt(10, 'Maximum depth to traverse')),
  path: Schema.optionalKey(
    Schema.String.annotate({ description: 'Directory path to query (defaults to root)' })
  ),
  pattern: Schema.optionalKey(
    Schema.String.annotate({ description: 'Glob pattern to filter files' })
  ),
});
export type QueryFileTreeInput = typeof QueryFileTreeInputSchema.Type;

export const RetrievalContextInputSchema = Schema.Struct({
  embeddingSetId: Schema.optionalKey(nonempty()),
  filePaths: Schema.optionalKey(Schema.Array(nonempty()).check(Schema.isMaxLength(5000))),
  limit: Schema.optionalKey(positiveInt(100)),
  maxChunks: Schema.optionalKey(positiveInt(100)),
  query: bounded(1, 2000),
  root: Schema.optionalKey(
    Schema.String.annotate({ description: WORKSPACE_SEARCH_ROOT_DESCRIPTION })
  ),
  selectionSnapshotId: Schema.optionalKey(nonempty()),
  threshold: Schema.optionalKey(range(1)),
  tokenBudget: Schema.optionalKey(positiveInt(200_000)),
});
export type RetrievalContextInput = typeof RetrievalContextInputSchema.Type;
export const QueryEmbeddingSpaceInputSchema = RetrievalContextInputSchema;
export type QueryEmbeddingSpaceInput = typeof QueryEmbeddingSpaceInputSchema.Type;

export const GrepSearchInputSchema = Schema.Struct({
  caseSensitive: Schema.optionalKey(
    Schema.Boolean.annotate({ description: 'Case-sensitive (default false)' })
  ),
  contextLines: Schema.optionalKey(
    offset(5, "Context lines around each 'content' match (default 0; opt in when needed)")
  ),
  filePaths: Schema.optionalKey(
    Schema.Array(nonempty()).check(Schema.isMaxLength(1000)).annotate({
      description: 'Restrict to these files: workspace-relative, or absolute inside an open folder',
    })
  ),
  isRegex: Schema.optionalKey(
    Schema.Boolean.annotate({ description: 'Use JavaScript regex (default false)' })
  ),
  maxResults: Schema.optionalKey(positiveInt(200, "'content' match cap (default 50)")),
  offset: Schema.optionalKey(offset(2000, 'Pagination offset')),
  outputMode: Schema.optionalKey(
    Schema.Literals(['files', 'content']).annotate({
      description:
        "'files' (default): paths + match counts. 'content': matching lines; narrow with filePaths.",
    })
  ),
  pattern: bounded(2, 500, 'Exact text (default) or JavaScript regex'),
  root: Schema.optionalKey(Schema.String.annotate({ description: GREP_GLOB_ROOT_DESCRIPTION })),
}).check(
  Schema.makeFilter((input) => {
    if (input.isRegex !== true) {
      return;
    }
    try {
      new RegExp(input.pattern);
      return;
    } catch {
      return {
        issue: 'pattern is not a valid JavaScript regular expression (isRegex is true)',
        path: ['pattern'],
      };
    }
  })
);
export type GrepSearchInput = typeof GrepSearchInputSchema.Type;

export const GlobWorkspaceInputSchema = Schema.Struct({
  includeIgnored: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        'Include excluded paths: build output, generated artifacts, and gitignored files such as coverage/ or .env* (default false)',
    })
  ),
  limit: Schema.optionalKey(positiveInt(1000, 'Match cap (default 200)')),
  offset: Schema.optionalKey(offset(100_000, 'Pagination offset')),
  pattern: bounded(1, 500, 'Workspace-relative glob; bare patterns match at any depth'),
  root: Schema.optionalKey(Schema.String.annotate({ description: GREP_GLOB_ROOT_DESCRIPTION })),
});
export type GlobWorkspaceInput = typeof GlobWorkspaceInputSchema.Type;

export const WebSearchInputSchema = Schema.Struct({
  maxResults: Schema.optionalKey(
    positiveInt(10, 'Maximum number of results to return (default 5, max 10)')
  ),
  query: bounded(
    2,
    400,
    'The web search query. Sent to an external search service (Tavily) — never include secrets or private workspace contents.'
  ),
});
export type WebSearchInput = typeof WebSearchInputSchema.Type;

export const WebExtractInputSchema = Schema.Struct({
  urls: Schema.Array(
    bounded(10, 2000, 'Absolute http(s) URL of a PUBLIC page — never internal/private hosts')
  )
    .check(Schema.isMinLength(1), Schema.isMaxLength(5))
    .annotate({
      description:
        'Public web pages to extract as markdown (1-5). Sent to an external extraction service (Tavily) — never include URLs carrying secrets or pointing at private/internal hosts.',
    }),
});
export type WebExtractInput = typeof WebExtractInputSchema.Type;

export const LspInspectInputSchema = Schema.Struct({
  line: positiveInt(Number.MAX_SAFE_INTEGER, '1-based line number of the symbol to inspect'),
  match: bounded(
    1,
    2000,
    'Prefer one unique JS/TS identifier (cursor is its first character). If it repeats on the line, pass a unique fragment with exactly one `<<<` before the intended occurrence'
  ),
  path: nonempty('Workspace-relative file path to inspect'),
  root: Schema.optionalKey(
    Schema.String.annotate({
      description: 'Which open folder the path is in (required only when multiple are open)',
    })
  ),
});
export type LspInspectInput = typeof LspInspectInputSchema.Type;
