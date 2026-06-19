import { TAPESTRY_COLOR_NAMES } from '@brainstrike/types';
import { z } from 'zod';

// ============================================================================
// Hybrid Search Tool Schema
// ============================================================================

export const HybridSearchInputSchema = z
  .object({
    query: z.string().min(1).max(2000).describe('Search query text'),
    embeddingSetId: z.string().min(1).describe('Embedding set ID for vector search'),
    limit: z.number().int().positive().max(100).optional().describe('Maximum results to return'),
    vectorWeight: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe('Weight for vector search (default 1.0)'),
    ftsWeight: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe('Weight for full-text search (default 1.0)'),
    vectorThreshold: z.number().min(0).max(1).optional().describe('Minimum similarity threshold'),
    filePaths: z
      .array(z.string().min(1))
      .max(1000)
      .optional()
      .describe('Filter to specific file paths'),
    chunkType: z
      .enum(['text', 'code', 'sentence', 'recursive'])
      .optional()
      .describe('Filter by chunk type'),
  })
  .strict();

export type HybridSearchInput = z.infer<typeof HybridSearchInputSchema>;

// ============================================================================
// Queue Status Tool Schema
// ============================================================================

export const QueueStatusInputSchema = z
  .object({
    embeddingSetId: z
      .string()
      .min(1)
      .optional()
      .describe('Optional: filter to specific embedding set'),
  })
  .strict();

export type QueueStatusInput = z.infer<typeof QueueStatusInputSchema>;

// ============================================================================
// Embedding Sets Tool Schemas
// ============================================================================

export const ListEmbeddingSetsInputSchema = z
  .object({
    includeStats: z.boolean().optional().describe('Include coverage statistics'),
    workspaceIndexOnly: z
      .boolean()
      .optional()
      .describe('Only return the embedding space configured as the current workspace index'),
  })
  .strict();

export type ListEmbeddingSetsInput = z.infer<typeof ListEmbeddingSetsInputSchema>;

export const CreateEmbeddingSetInputSchema = z
  .object({
    name: z.string().min(1).max(100).describe('Name for the embedding set'),
    modelKey: z.string().min(1).describe('Model key (provider::model format)'),
    description: z.string().max(500).optional().describe('Optional description'),
  })
  .strict();

export type CreateEmbeddingSetInput = z.infer<typeof CreateEmbeddingSetInputSchema>;

// ============================================================================
// File Tree Tool Schema
// ============================================================================

export const QueryFileTreeInputSchema = z
  .object({
    path: z.string().optional().describe('Directory path to query (defaults to root)'),
    pattern: z.string().optional().describe('Glob pattern to filter files'),
    maxDepth: z.number().int().positive().max(10).optional().describe('Maximum depth to traverse'),
    includeHidden: z.boolean().optional().describe('Include hidden files/directories'),
  })
  .strict();

export type QueryFileTreeInput = z.infer<typeof QueryFileTreeInputSchema>;

// ============================================================================
// System Diagnostics Tool Schema
// ============================================================================

export const SystemDiagnosticsInputSchema = z
  .object({
    categories: z
      .array(z.enum(['database', 'queue', 'worker', 'storage', 'all']))
      .optional()
      .describe('Diagnostic categories to check'),
  })
  .strict();

export type SystemDiagnosticsInput = z.infer<typeof SystemDiagnosticsInputSchema>;

// ============================================================================
// Re-embed Collection Tool Schema
// ============================================================================

export const ReembedCollectionInputSchema = z
  .object({
    embeddingSetId: z.string().min(1).describe('Embedding set ID to re-embed'),
    reason: z.string().max(200).optional().describe('Reason for re-embedding'),
  })
  .strict();

// ============================================================================
// Workspace Tool Schemas
// ============================================================================

const ROOT_QUALIFIER_DESCRIPTION =
  'Which open folder the path is in: its name or id (from listWorkspaceContext or a search result). Required only when multiple folders are open; omit when there is one.';

const ROOT_WRITE_GUARD_DESCRIPTION =
  'Which open folder to curate: its name or id (from listWorkspaceContext or a search result). Required only when multiple folders are open; omit when there is one. The selection is applied to that folder even if it is not the focused one.';

export const ReadWorkspaceFileInputSchema = z
  .object({
    path: z.string().min(1).describe('Workspace-relative file path'),
    root: z.string().optional().describe(ROOT_QUALIFIER_DESCRIPTION),
    startLine: z.number().int().positive().optional().describe('Optional starting line (1-based)'),
    endLine: z.number().int().positive().optional().describe('Optional ending line (1-based)'),
    maxChars: z
      .number()
      .int()
      .positive()
      .max(50_000)
      .optional()
      .describe('Maximum characters to return before truncation'),
  })
  .strict();

export type ReadWorkspaceFileInput = z.infer<typeof ReadWorkspaceFileInputSchema>;

export const WriteWorkspaceFileInputSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .describe(
        'Workspace-relative file path to write (same path convention as readWorkspaceFile). Parent directories are created if missing.'
      ),
    content: z
      // Outer DoS guard only; the desktop tool enforces the authoritative ~2 MB
      // UTF-8 BYTE cap (this counts UTF-16 code units, so it sits well above it).
      .string()
      .max(8_000_000)
      .describe('Full UTF-8 file content to write (up to ~2 MB). Overwrites any existing file.'),
    root: z.string().optional().describe(ROOT_QUALIFIER_DESCRIPTION),
  })
  .strict();

export type WriteWorkspaceFileInput = z.infer<typeof WriteWorkspaceFileInputSchema>;

export const StringReplaceWorkspaceFileInputSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .describe(
        'Workspace-relative file path to edit (same path convention as readWorkspaceFile). The file must already exist.'
      ),
    oldStr: z
      // Outer DoS guard only; the desktop tool reads the file under the same
      // ~2 MB BYTE cap as readWorkspaceFile (this counts UTF-16 code units).
      .string()
      .min(1)
      .max(8_000_000)
      .describe(
        'The exact block of existing text to replace. Pass WHOLE LINES with enough surrounding context that the block uniquely identifies ONE location: a block that matches more than once is REFUSED (re-call with more context), and a short fragment can match inside a larger token (e.g. "bar" inside "foobarbaz"), so prefer complete lines over substrings.'
      ),
    newStr: z
      .string()
      .max(8_000_000)
      .describe('The replacement text. Use an empty string to delete the matched block.'),
    root: z.string().optional().describe(ROOT_QUALIFIER_DESCRIPTION),
  })
  .strict();

export type StringReplaceWorkspaceFileInput = z.infer<typeof StringReplaceWorkspaceFileInputSchema>;

export const ReadWorkspaceDirectoryInputSchema = z
  .object({
    path: z.string().optional().describe('Directory path (defaults to root)'),
    root: z.string().optional().describe(ROOT_QUALIFIER_DESCRIPTION),
    depth: z.number().int().min(0).max(5).optional().describe('Maximum traversal depth'),
    maxEntries: z
      .number()
      .int()
      .positive()
      .max(500)
      .optional()
      .describe('Maximum entries to return'),
    includeFiles: z.boolean().optional().describe('Include files in the listing'),
    includeDirectories: z.boolean().optional().describe('Include directories in the listing'),
    includeHidden: z.boolean().optional().describe('Include hidden files and directories'),
    detail: z
      .boolean()
      .optional()
      .describe('Include per-entry size and depth metadata (default false: path + type only)'),
    offset: z
      .number()
      .int()
      .min(0)
      .max(5000)
      .optional()
      .describe('Skip this many entries to continue a truncated listing'),
  })
  .strict();

export type ReadWorkspaceDirectoryInput = z.infer<typeof ReadWorkspaceDirectoryInputSchema>;

export const FindWorkspaceSymbolInputSchema = z
  .object({
    path: z.string().min(1).describe('Workspace-relative file path'),
    root: z.string().optional().describe(ROOT_QUALIFIER_DESCRIPTION),
    query: z.string().min(1).describe('Symbol name or substring to find'),
    maxMatches: z.number().int().positive().max(20).optional().describe('Max matches (default 5)'),
    contextLines: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .describe('Preview lines before/after each match (default 2)'),
  })
  .strict();

export type FindWorkspaceSymbolInput = z.infer<typeof FindWorkspaceSymbolInputSchema>;

export const ListWorkspaceContextInputSchema = z
  .object({
    includeTokenEstimates: z
      .boolean()
      .optional()
      .describe('Include token estimates for selected files when available'),
    detail: z
      .boolean()
      .optional()
      .describe(
        'Include full curated-context metadata with per-file Tapestry ranges (default: compact summary with counts and token budgets)'
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .optional()
      .describe('Skip this many selected file paths to continue a truncated listing'),
  })
  .strict();

export type ListWorkspaceContextInput = z.infer<typeof ListWorkspaceContextInputSchema>;

export const ReadWorkspaceContextInputSchema = z
  .object({
    filePaths: z
      .array(z.string().min(1))
      .min(1)
      .max(5000)
      .optional()
      .describe('Workspace-relative file paths to read. Defaults to selected workspace context.'),
    root: z.string().optional().describe(ROOT_QUALIFIER_DESCRIPTION),
    tokenBudget: z
      .number()
      .int()
      .positive()
      .max(200_000)
      .optional()
      .describe('Maximum approximate output tokens for all returned file contents'),
    maxFiles: z
      .number()
      .int()
      .positive()
      .max(500)
      .optional()
      .describe('Maximum number of files to include'),
    maxCharsPerFile: z
      .number()
      .int()
      .positive()
      .max(50_000)
      .optional()
      .describe('Maximum characters to return per file before truncation'),
    useTapestrySelections: z
      .boolean()
      .optional()
      .describe('Apply selected Tapestry line ranges when reading curated workspace context'),
  })
  .strict();

export type ReadWorkspaceContextInput = z.infer<typeof ReadWorkspaceContextInputSchema>;

export const UpdateWorkspaceContextSelectionInputSchema = z
  .object({
    filePaths: z
      .array(z.string().min(1))
      .min(1)
      .max(5000)
      .describe('Workspace-relative file paths to select in the workspace context explorer'),
    mode: z
      .enum(['replace', 'add', 'remove'])
      .optional()
      .describe('Selection update strategy (default: add)'),
    folderId: z.string().min(1).optional().describe('Optional folder id for multi-root workspaces'),
    root: z.string().optional().describe(ROOT_WRITE_GUARD_DESCRIPTION),
  })
  .strict();

export type UpdateWorkspaceContextSelectionInput = z.infer<
  typeof UpdateWorkspaceContextSelectionInputSchema
>;

const WorkspaceTapestryRangeInputSchema = z
  .object({
    startLine: z.number().int().positive().describe('1-based inclusive starting line'),
    endLine: z.number().int().positive().describe('1-based inclusive ending line'),
    isActive: z.boolean().optional().describe('Whether this range contributes to context output'),
    color: z
      .enum(TAPESTRY_COLOR_NAMES)
      .optional()
      .describe(
        'Optional named color to group related ranges (red, orange, yellow, green, cyan, blue, purple, pink, gray). Reuse the same color for the same concept. Omit to auto-assign.'
      ),
  })
  .strict()
  .refine((value) => value.endLine >= value.startLine, {
    message: 'endLine must be greater than or equal to startLine',
    path: ['endLine'],
  });

export const UpdateWorkspaceTapestrySelectionsInputSchema = z
  .object({
    updates: z
      .array(
        z
          .object({
            path: z.string().min(1).describe('Workspace-relative file path'),
            ranges: z
              .array(WorkspaceTapestryRangeInputSchema)
              .max(50)
              .describe('1-based inclusive line ranges for this file'),
          })
          .strict()
      )
      .min(1)
      .max(500)
      .describe('Tapestry selection updates grouped by file'),
    mode: z
      .enum(['replace', 'add', 'clear'])
      .optional()
      .describe('Range update strategy for each file (default: replace)'),
    folderId: z.string().min(1).optional().describe('Optional folder id for multi-root workspaces'),
    root: z.string().optional().describe(ROOT_WRITE_GUARD_DESCRIPTION),
    selectFiles: z
      .boolean()
      .optional()
      .describe('Also add affected files to the workspace context selection (default: true)'),
  })
  .strict();

export type UpdateWorkspaceTapestrySelectionsInput = z.infer<
  typeof UpdateWorkspaceTapestrySelectionsInputSchema
>;

/**
 * @deprecated Use UpdateWorkspaceContextSelectionInputSchema. The legacy root-tree
 * tool is no longer registered in the assistant runtime.
 */
export const SelectRootTreeFilesInputSchema = z
  .object({
    filePaths: z
      .array(z.string().min(1))
      .min(1)
      .max(5000)
      .describe('Workspace-relative file paths to add to the left root tree selection'),
    mode: z
      .enum(['replace', 'add', 'remove'])
      .optional()
      .describe('Selection update strategy for root tree selection (default: add)'),
    folderId: z
      .string()
      .min(1)
      .optional()
      .describe('Optional folder identifier when multiple roots are present'),
  })
  .strict();

/** @deprecated Use UpdateWorkspaceContextSelectionInput. */
export type SelectRootTreeFilesInput = z.infer<typeof SelectRootTreeFilesInputSchema>;

/**
 * @deprecated Use UpdateWorkspaceContextSelectionInputSchema. The legacy preview
 * context tool is no longer registered in the assistant runtime.
 */
export const UpdatePreviewContextFilesInputSchema = z
  .object({
    filePaths: z
      .array(z.string().min(1))
      .min(1)
      .max(5000)
      .describe('Workspace-relative file paths to adjust in the preview context selection'),
    mode: z
      .enum(['replace', 'add', 'remove'])
      .optional()
      .describe('Selection update strategy for preview context files (default: add)'),
    folderId: z
      .string()
      .min(1)
      .optional()
      .describe('Optional folder identifier when multiple roots are present'),
  })
  .strict();

/** @deprecated Use UpdateWorkspaceContextSelectionInput. */
export type UpdatePreviewContextFilesInput = z.infer<typeof UpdatePreviewContextFilesInputSchema>;

const EchoInput = z.object({ text: z.string().min(1) }).strict();

export const RetrievalContextInputSchema = z
  .object({
    query: z.string().min(1).max(2000),
    limit: z.number().int().positive().max(100).optional(),
    threshold: z.number().min(0).max(1).optional(),
    tokenBudget: z.number().int().positive().max(200_000).optional(),
    maxChunks: z.number().int().positive().max(100).optional(),
    embeddingSetId: z.string().min(1).optional(),
    filePaths: z.array(z.string().min(1)).max(5000).optional(),
    selectionSnapshotId: z.string().min(1).optional(),
    root: z
      .string()
      .optional()
      .describe(
        'Optional: scope retrieval to one open folder by its name or id (from listWorkspaceContext or a result). Omit to search every open folder; results are labelled with their root.'
      ),
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
    pattern: z
      .string()
      .min(2)
      .max(500)
      .describe('Exact text (default) or JavaScript regex to find in indexed file content'),
    isRegex: z
      .boolean()
      .optional()
      .describe('Treat pattern as a JavaScript regular expression (default false)'),
    caseSensitive: z.boolean().optional().describe('Case-sensitive matching (default false)'),
    filePaths: z
      .array(z.string().min(1))
      .max(1000)
      .optional()
      .describe('Restrict the search to specific indexed file paths'),
    root: z
      .string()
      .optional()
      .describe(
        'Optional: scope the search to one open folder by its name or id (from listWorkspaceContext or a result). Omit to search every open folder; results are always labelled with their root.'
      ),
    contextLines: z
      .number()
      .int()
      .min(0)
      .max(5)
      .optional()
      .describe("Lines of context before/after each match in 'content' mode (default 1)"),
    maxResults: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .describe("Maximum 'content' matches to return (default 50)"),
    outputMode: z
      .enum(['files', 'content'])
      .optional()
      .describe(
        "'files' (default) lists matching file paths with per-file match counts — a cheap survey for narrowing. 'content' returns line-level matches with context; scope it with filePaths."
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .max(2000)
      .optional()
      .describe(
        'Skip this many files/matches to continue a truncated result instead of re-querying'
      ),
  })
  .strict();

export type GrepSearchInput = z.infer<typeof GrepSearchInputSchema>;

export const GlobWorkspaceInputSchema = z
  .object({
    pattern: z
      .string()
      .min(1)
      .max(500)
      .describe(
        'Glob pattern matched against workspace-relative paths, e.g. "**/*.test.ts", "src/**/*.tsx", "**/package.json". A bare pattern with no leading "**/" or "/" matches at any depth (so "*.ts" behaves like "**/*.ts").'
      ),
    root: z
      .string()
      .optional()
      .describe(
        'Optional: scope the walk to one open folder by its name or id (from listWorkspaceContext or a result). Omit to enumerate every open folder; results are always labelled with their root.'
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(1000)
      .optional()
      .describe('Maximum matching paths to return (default 200)'),
    offset: z
      .number()
      .int()
      .min(0)
      .max(100_000)
      .optional()
      .describe('Skip this many matches to continue a truncated result instead of re-querying'),
    includeIgnored: z
      .boolean()
      .optional()
      .describe(
        'Include files normally excluded (.git, node_modules, dist/build output, lockfiles, minified/generated artifacts). Default false: the same exclusions the workspace indexer applies.'
      ),
  })
  .strict();

export type GlobWorkspaceInput = z.infer<typeof GlobWorkspaceInputSchema>;

export const ExecuteCommandInputSchema = z
  .object({
    command: z
      .string()
      .min(1)
      .max(10_000)
      .describe(
        'The shell command line to run, passed verbatim to the shell as `-c command`. Arbitrary execution — there is NO sandbox.'
      ),
    root: z
      .string()
      .optional()
      .describe(
        'Optional: which open folder to start in, by name or id (from listWorkspaceContext). Omit when only one folder is open; required to disambiguate when several are.'
      ),
    cwd: z
      .string()
      .optional()
      .describe(
        'Optional start directory. Absolute, or relative to the chosen root. MUST resolve inside an open workspace folder (the command itself is unrestricted; only the start dir is pinned). Defaults to the workspace root.'
      ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(600_000)
      .optional()
      .describe(
        'Kill the whole process tree after this many milliseconds (default 120000, max 600000). On timeout the result reports timedOut: true.'
      ),
  })
  .strict();

export type ExecuteCommandInput = z.infer<typeof ExecuteCommandInputSchema>;

const schemaMap: Record<string, z.ZodSchema> = {
  // Web tools
  'web.echo': EchoInput,
  // Minimal BrainStrike native tools
  'brainstrike.findWorkspaceSymbol': FindWorkspaceSymbolInputSchema,
  'brainstrike.readWorkspaceFile': ReadWorkspaceFileInputSchema,
  'brainstrike.writeWorkspaceFile': WriteWorkspaceFileInputSchema,
  'brainstrike.stringReplaceWorkspaceFile': StringReplaceWorkspaceFileInputSchema,
  'brainstrike.readWorkspaceDirectory': ReadWorkspaceDirectoryInputSchema,
  'brainstrike.listWorkspaceContext': ListWorkspaceContextInputSchema,
  'brainstrike.readWorkspaceContext': ReadWorkspaceContextInputSchema,
  'brainstrike.updateWorkspaceContextSelection': UpdateWorkspaceContextSelectionInputSchema,
  'brainstrike.updateWorkspaceTapestrySelections': UpdateWorkspaceTapestrySelectionsInputSchema,
  'brainstrike.listEmbeddingSpaces': ListEmbeddingSetsInputSchema,
  'brainstrike.queryEmbeddingSpace': QueryEmbeddingSpaceInputSchema,
  'brainstrike.grepSearch': GrepSearchInputSchema,
  'brainstrike.globWorkspace': GlobWorkspaceInputSchema,
  'brainstrike.executeCommand': ExecuteCommandInputSchema,
};

function formatZodIssue(issue: z.ZodIssue): string {
  const path = Array.isArray(issue.path) ? issue.path.join('.') : String(issue.path);
  const prefix = path.length > 0 ? `${path} ` : '';
  return `${prefix}${issue.message}`;
}

function parseWithSchema(
  schema: z.ZodSchema,
  params: Record<string, unknown> | undefined
): { ok: true; data: unknown } | { ok: false; issues: string[] } {
  const res = schema.safeParse(params ?? {});
  if (!res.success) {
    return {
      ok: false,
      issues: res.error.issues.map((issue) => formatZodIssue(issue)),
    };
  }
  return { ok: true, data: res.data };
}

export function validateToolInput(
  name: string,
  params: Record<string, unknown> | undefined
): { ok: true; data: unknown } | { ok: false; issues: string[] } {
  try {
    const schema = schemaMap[name];
    if (schema) {
      return parseWithSchema(schema, params);
    }
    // Only canonical BrainStrike-native tool IDs are validated here.
    // Runtime-discovered MCP tools must keep their server-provided names and are
    // forwarded without local aliasing or fallback validation.
    return { ok: true, data: params ?? {} };
  } catch (err) {
    return { ok: false, issues: [err instanceof Error ? err.message : String(err)] };
  }
}
