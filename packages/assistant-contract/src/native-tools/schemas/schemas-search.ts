import { z } from 'zod';

const WORKSPACE_SEARCH_ROOT_DESCRIPTION =
  'Open-folder name/id. Omit for the thread-bound folder; an unbound request searches all open folders. To cover every folder in a bound thread, call once per root id. Results include their root.';

/** grep and glob without a root search every thread folder (BST-1990, D3). */
const GREP_GLOB_ROOT_DESCRIPTION =
  "Open-folder name/id. Omit to search all of this thread's folders. Results include their root.";

// ============================================================================
// Hybrid Search Tool Schema
// ============================================================================

export const HybridSearchInputSchema = z
  .object({
    chunkType: z
      .enum(['text', 'code', 'sentence', 'recursive'])
      .optional()
      .describe('Filter by chunk type'),
    embeddingSetId: z
      .string()
      .min(1)
      .optional()
      .describe('Embedding set ID for vector search; omit to use the Workspace Index'),
    filePaths: z
      .array(z.string().min(1))
      // Matches the repositories' MAX_INLINE_FILE_PATHS: both search arms throw
      // above 500 inline paths, so the schema refuses them up front.
      .max(500)
      .optional()
      .describe('Filter to specific file paths (max 500)'),
    ftsWeight: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe('Weight for full-text search (default 1.0)'),
    limit: z.number().int().positive().max(100).optional().describe('Maximum results to return'),
    query: z.string().min(1).max(2000).describe('Search query text'),
    root: z.string().min(1).optional().describe(WORKSPACE_SEARCH_ROOT_DESCRIPTION),
    vectorThreshold: z.number().min(0).max(1).optional().describe('Minimum similarity threshold'),
    vectorWeight: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe('Weight for vector search (default 1.0)'),
  })
  .strict();

export type HybridSearchInput = z.infer<typeof HybridSearchInputSchema>;

// ============================================================================
// File Tree Tool Schema
// ============================================================================

export const QueryFileTreeInputSchema = z
  .object({
    includeHidden: z.boolean().optional().describe('Include hidden files/directories'),
    maxDepth: z.number().int().positive().max(10).optional().describe('Maximum depth to traverse'),
    path: z.string().optional().describe('Directory path to query (defaults to root)'),
    pattern: z.string().optional().describe('Glob pattern to filter files'),
  })
  .strict();

export type QueryFileTreeInput = z.infer<typeof QueryFileTreeInputSchema>;

export const RetrievalContextInputSchema = z
  .object({
    embeddingSetId: z.string().min(1).optional(),
    filePaths: z.array(z.string().min(1)).max(5000).optional(),
    limit: z.number().int().positive().max(100).optional(),
    maxChunks: z.number().int().positive().max(100).optional(),
    query: z.string().min(1).max(2000),
    root: z.string().optional().describe(WORKSPACE_SEARCH_ROOT_DESCRIPTION),
    selectionSnapshotId: z.string().min(1).optional(),
    threshold: z.number().min(0).max(1).optional(),
    tokenBudget: z.number().int().positive().max(200_000).optional(),
  })
  .strict();

export type RetrievalContextInput = z.infer<typeof RetrievalContextInputSchema>;

export const QueryEmbeddingSpaceInputSchema = RetrievalContextInputSchema;

export type QueryEmbeddingSpaceInput = z.infer<typeof QueryEmbeddingSpaceInputSchema>;

// ============================================================================
// Grep Search Tool Schema
// ============================================================================

export const GrepSearchInputSchema = z
  .object({
    caseSensitive: z.boolean().optional().describe('Case-sensitive (default false)'),
    contextLines: z
      .number()
      .int()
      .min(0)
      .max(5)
      .optional()
      .describe("Context lines around each 'content' match (default 0; opt in when needed)"),
    filePaths: z
      .array(z.string().min(1))
      .max(1000)
      .optional()
      // BST-764: states the contract, but tightly — the native tool prompt
      // budget had ~13 tokens of headroom (BST-927), and the verbose first
      // draft of this line overran it by 25.
      .describe('Restrict to these files: workspace-relative, or absolute inside an open folder'),
    isRegex: z.boolean().optional().describe('Use JavaScript regex (default false)'),
    maxResults: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .describe("'content' match cap (default 50)"),
    offset: z.number().int().min(0).max(2000).optional().describe('Pagination offset'),
    outputMode: z
      .enum(['files', 'content'])
      .optional()
      .describe(
        "'files' (default): paths + match counts. 'content': matching lines; narrow with filePaths."
      ),
    pattern: z.string().min(2).max(500).describe('Exact text (default) or JavaScript regex'),
    root: z.string().optional().describe(GREP_GLOB_ROOT_DESCRIPTION),
  })
  .strict()
  // Fail-fast: when the caller asks for regex matching, reject an invalid pattern
  // at parse rather than deferring the failure to execution (no silent fallback).
  .refine(
    (value) => {
      if (value.isRegex !== true) {
        return true;
      }
      try {
        // Compilation is what validates the syntax; flags don't affect validity here.
        new RegExp(value.pattern);
        return true;
      } catch {
        return false;
      }
    },
    {
      message: 'pattern is not a valid JavaScript regular expression (isRegex is true)',
      path: ['pattern'],
    }
  );

export type GrepSearchInput = z.infer<typeof GrepSearchInputSchema>;

export const GlobWorkspaceInputSchema = z
  .object({
    includeIgnored: z
      .boolean()
      .optional()
      .describe(
        'Include excluded paths: build output, generated artifacts, and gitignored files such as coverage/ or .env* (default false)'
      ),
    limit: z.number().int().positive().max(1000).optional().describe('Match cap (default 200)'),
    offset: z.number().int().min(0).max(100_000).optional().describe('Pagination offset'),
    pattern: z
      .string()
      .min(1)
      .max(500)
      .describe('Workspace-relative glob; bare patterns match at any depth'),
    root: z.string().optional().describe(GREP_GLOB_ROOT_DESCRIPTION),
  })
  .strict();

export type GlobWorkspaceInput = z.infer<typeof GlobWorkspaceInputSchema>;

// ============================================================================
// Web Search Tool Schema
// ============================================================================

export const WebSearchInputSchema = z
  .object({
    maxResults: z
      .number()
      .int()
      .positive()
      .max(10)
      .optional()
      .describe('Maximum number of results to return (default 5, max 10)'),
    query: z
      .string()
      .min(2)
      .max(400)
      .describe(
        'The web search query. Sent to an external search service (Tavily) — never include secrets or private workspace contents.'
      ),
  })
  .strict();

export type WebSearchInput = z.infer<typeof WebSearchInputSchema>;

// ============================================================================
// Web Extract Tool Schema
// ============================================================================

export const WebExtractInputSchema = z
  .object({
    urls: z
      .array(
        z
          .string()
          .min(10)
          .max(2000)
          .describe('Absolute http(s) URL of a PUBLIC page — never internal/private hosts')
      )
      .min(1)
      .max(5)
      .describe(
        'Public web pages to extract as markdown (1-5). Sent to an external extraction service (Tavily) — never include URLs carrying secrets or pointing at private/internal hosts.'
      ),
  })
  .strict();

export type WebExtractInput = z.infer<typeof WebExtractInputSchema>;

// ============================================================================
// LSP Inspect Tool Schema (report R2 Phase B)
// ============================================================================

export const LspInspectInputSchema = z
  .object({
    line: z.number().int().positive().describe('1-based line number of the symbol to inspect'),
    match: z
      .string()
      .min(1)
      .max(2000)
      .describe(
        'Prefer one unique JS/TS identifier (cursor is its first character). If it repeats on the line, pass a unique fragment with exactly one `<<<` before the intended occurrence'
      ),
    path: z.string().min(1).describe('Workspace-relative file path to inspect'),
    root: z
      .string()
      .optional()
      .describe('Which open folder the path is in (required only when multiple are open)'),
  })
  .strict();

export type LspInspectInput = z.infer<typeof LspInspectInputSchema>;
