import {
  type DesktopNativeToolId,
  isDesktopNativeToolId,
  NATIVE_TOOL_ID,
  WEB_EXTRACT_TOOL_ID,
  WEB_SEARCH_TOOL_ID,
} from '@brainstrike/assistant-contract/tool-metadata';
import { TAPESTRY_COLOR_NAMES } from '@brainstrike/types';
import { z } from 'zod';
import { ReadToolOutputArtifactCursorInputSchema } from '../mastra/tool-output-artifact-reader';

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
    root: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Optional folder name or id to scope the search to one open folder (omit to search all)'
      ),
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
    description: z.string().max(500).optional().describe('Optional description'),
    modelKey: z.string().min(1).describe('Model key (provider::model format)'),
    name: z.string().min(1).max(100).describe('Name for the embedding set'),
  })
  .strict();

export type CreateEmbeddingSetInput = z.infer<typeof CreateEmbeddingSetInputSchema>;

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
  'Open-folder name/id for this path. Required only when multiple folders are open.';

const ROOT_WRITE_GUARD_DESCRIPTION =
  'Open-folder name/id. Omit for the Focused folder; an explicit root always wins.';

export const ReadWorkspaceFileInputSchema = z
  .object({
    cursor: z
      .string()
      .regex(/^rfh_[A-Za-z0-9_-]{22}$/)
      .nullish()
      .describe(
        'Short nextCursor handle from the previous page. Pass it unchanged with optional maxChars and omit every other field'
      ),
    endLine: z
      .number()
      .int()
      .positive()
      .nullish()
      .describe(
        'Last 1-based line; omit with cursor unless replaying the original value unchanged'
      ),
    maxChars: z.number().int().positive().max(50_000).nullish().describe('Output character cap'),
    path: z
      .string()
      .min(1)
      .nullish()
      .describe('Workspace-relative file path; required only when starting a new read'),
    root: z.string().nullish().describe(ROOT_QUALIFIER_DESCRIPTION),
    startLine: z
      .number()
      .int()
      .positive()
      .nullish()
      .describe(
        'First 1-based line; omit with cursor unless replaying the original value unchanged'
      ),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.cursor) {
      for (const field of ['path', 'root'] as const) {
        if (input[field] !== null && input[field] !== undefined) {
          context.addIssue({
            code: 'custom',
            message: `Omit ${field} when continuing with cursor`,
            path: [field],
          });
        }
      }
      return;
    }
    if (!input.path) {
      context.addIssue({
        code: 'custom',
        message: 'path is required when starting a new read',
        path: ['path'],
      });
    }
  });

export type ReadWorkspaceFileInput = z.infer<typeof ReadWorkspaceFileInputSchema>;

export const WriteWorkspaceFileInputSchema = z
  .object({
    content: z
      // Outer DoS guard only; the desktop tool enforces the authoritative ~2 MB
      // UTF-8 BYTE cap (this counts UTF-16 code units, so it sits well above it).
      .string()
      .max(8_000_000)
      .describe('Full UTF-8 content (up to ~2 MB); overwrites an existing file'),
    path: z.string().min(1).describe('Workspace-relative path; creates missing parent directories'),
    root: z.string().optional().describe(ROOT_QUALIFIER_DESCRIPTION),
  })
  .strict();

export type WriteWorkspaceFileInput = z.infer<typeof WriteWorkspaceFileInputSchema>;

export const StringReplaceWorkspaceFileInputSchema = z
  .object({
    newStr: z.string().max(8_000_000).describe('Replacement text; empty deletes the matched block'),
    oldStr: z
      // Outer DoS guard only; the desktop tool reads the file under the same
      // ~2 MB BYTE cap as readWorkspaceFile (this counts UTF-16 code units).
      .string()
      .min(1)
      .max(8_000_000)
      .describe(
        'Existing text block. Use whole lines and enough context to identify one location; ambiguous matches are refused.'
      ),
    path: z.string().min(1).describe('Existing workspace-relative file path'),
    root: z.string().optional().describe(ROOT_QUALIFIER_DESCRIPTION),
  })
  .strict();

export type StringReplaceWorkspaceFileInput = z.infer<typeof StringReplaceWorkspaceFileInputSchema>;

export const DeleteWorkspaceFileInputSchema = z
  .object({
    path: z.string().min(1).describe('Workspace-relative file path; directories are refused'),
    root: z.string().optional().describe(ROOT_QUALIFIER_DESCRIPTION),
  })
  .strict();

export type DeleteWorkspaceFileInput = z.infer<typeof DeleteWorkspaceFileInputSchema>;

export const RenameWorkspaceFileInputSchema = z
  .object({
    fromPath: z.string().min(1).describe('Existing workspace-relative source file'),
    root: z.string().optional().describe(ROOT_QUALIFIER_DESCRIPTION),
    toPath: z
      .string()
      .min(1)
      .describe('Destination path in the same root; no overwrite; creates missing parents'),
  })
  .strict();

export type RenameWorkspaceFileInput = z.infer<typeof RenameWorkspaceFileInputSchema>;

export const ReadWorkspaceDirectoryInputSchema = z
  .object({
    depth: z.number().int().min(0).max(5).optional().describe('Traversal depth (max 5)'),
    detail: z.boolean().optional().describe('Include entry size/depth (default false)'),
    includeDirectories: z.boolean().optional().describe('Include directories'),
    includeFiles: z.boolean().optional().describe('Include files'),
    includeHidden: z.boolean().optional().describe('Include hidden entries'),
    maxEntries: z.number().int().positive().max(500).optional().describe('Entry cap'),
    offset: z.number().int().min(0).max(5000).optional().describe('Pagination offset'),
    path: z.string().optional().describe('Directory path (default root)'),
    root: z.string().optional().describe(ROOT_QUALIFIER_DESCRIPTION),
  })
  .strict();

export type ReadWorkspaceDirectoryInput = z.infer<typeof ReadWorkspaceDirectoryInputSchema>;

export const FindWorkspaceSymbolInputSchema = z
  .object({
    contextLines: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .describe('Preview lines before/after each match (default 2)'),
    maxMatches: z.number().int().positive().max(20).optional().describe('Max matches (default 5)'),
    path: z.string().min(1).describe('Workspace-relative file path'),
    query: z.string().min(1).describe('Symbol name or substring to find'),
    root: z.string().optional().describe(ROOT_QUALIFIER_DESCRIPTION),
  })
  .strict();

export type FindWorkspaceSymbolInput = z.infer<typeof FindWorkspaceSymbolInputSchema>;

export const ListWorkspaceContextInputSchema = z
  .object({
    detail: z
      .boolean()
      .optional()
      .describe(
        'Include full curated-context metadata with per-file Tapestry ranges (default: compact summary with counts and token budgets)'
      ),
    includeTokenEstimates: z
      .boolean()
      .optional()
      .describe('Include token estimates for selected files when available'),
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
    maxCharsPerFile: z
      .number()
      .int()
      .positive()
      .max(50_000)
      .optional()
      .describe('Per-file character cap'),
    maxFiles: z.number().int().positive().max(500).optional().describe('File count cap'),
    root: z.string().optional().describe(ROOT_QUALIFIER_DESCRIPTION),
    tokenBudget: z
      .number()
      .int()
      .positive()
      .max(200_000)
      .optional()
      .describe('Total output token cap'),
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
    folderId: z.string().min(1).optional().describe('Optional folder id for multi-root workspaces'),
    mode: z
      .enum(['replace', 'add', 'remove'])
      .optional()
      .describe('Selection update strategy (default: add)'),
    root: z.string().optional().describe(ROOT_WRITE_GUARD_DESCRIPTION),
  })
  .strict();

export type UpdateWorkspaceContextSelectionInput = z.infer<
  typeof UpdateWorkspaceContextSelectionInputSchema
>;

const WorkspaceTapestryRangeInputSchema = z
  .object({
    color: z
      .enum(TAPESTRY_COLOR_NAMES)
      .optional()
      .describe('Group color; reuse per concept; omit to auto-assign'),
    endLine: z.number().int().positive().describe('1-based inclusive ending line'),
    isActive: z.boolean().optional().describe('Whether this range contributes to context output'),
    startLine: z.number().int().positive().describe('1-based inclusive starting line'),
  })
  .strict()
  .refine((value) => value.endLine >= value.startLine, {
    message: 'endLine must be greater than or equal to startLine',
    path: ['endLine'],
  });

export const UpdateWorkspaceTapestrySelectionsInputSchema = z
  .object({
    folderId: z.string().min(1).optional().describe('Optional folder id for multi-root workspaces'),
    mode: z
      .enum(['replace', 'add', 'clear'])
      .optional()
      .describe('Range update strategy for each file (default: replace)'),
    root: z.string().optional().describe(ROOT_WRITE_GUARD_DESCRIPTION),
    selectFiles: z
      .boolean()
      .optional()
      .describe('Also add affected files to the workspace context selection (default: true)'),
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
    folderId: z
      .string()
      .min(1)
      .optional()
      .describe('Optional folder identifier when multiple roots are present'),
    mode: z
      .enum(['replace', 'add', 'remove'])
      .optional()
      .describe('Selection update strategy for root tree selection (default: add)'),
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
    folderId: z
      .string()
      .min(1)
      .optional()
      .describe('Optional folder identifier when multiple roots are present'),
    mode: z
      .enum(['replace', 'add', 'remove'])
      .optional()
      .describe('Selection update strategy for preview context files (default: add)'),
  })
  .strict();

/** @deprecated Use UpdateWorkspaceContextSelectionInput. */
export type UpdatePreviewContextFilesInput = z.infer<typeof UpdatePreviewContextFilesInputSchema>;

export const RetrievalContextInputSchema = z
  .object({
    embeddingSetId: z.string().min(1).optional(),
    filePaths: z.array(z.string().min(1)).max(5000).optional(),
    limit: z.number().int().positive().max(100).optional(),
    maxChunks: z.number().int().positive().max(100).optional(),
    query: z.string().min(1).max(2000),
    root: z
      .string()
      .optional()
      .describe('Open-folder name/id; omit to search all. Results include their root.'),
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
      .describe("Context lines in 'content' mode (default 1)"),
    filePaths: z
      .array(z.string().min(1))
      .max(1000)
      .optional()
      .describe('Restrict to these file paths'),
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
        "'files' (default): paths + match counts. 'content': line matches + context; narrow with filePaths."
      ),
    pattern: z.string().min(2).max(500).describe('Exact text (default) or JavaScript regex'),
    root: z
      .string()
      .optional()
      .describe('Open-folder name/id; omit to search all. Results include their root.'),
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
      .describe('Include normally excluded/generated paths (default false)'),
    limit: z.number().int().positive().max(1000).optional().describe('Match cap (default 200)'),
    offset: z.number().int().min(0).max(100_000).optional().describe('Pagination offset'),
    pattern: z
      .string()
      .min(1)
      .max(500)
      .describe('Workspace-relative glob; bare patterns match at any depth'),
    root: z
      .string()
      .optional()
      .describe('Open-folder name/id; omit to enumerate all. Results include their root.'),
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
      .min(3)
      .max(2000)
      .describe(
        'Target line or unique fragment with exactly one `<<<` before the symbol; refused when marker-stripped text is absent'
      ),
    path: z.string().min(1).describe('Workspace-relative file path to inspect'),
    root: z
      .string()
      .optional()
      .describe('Which open folder the path is in (required only when multiple are open)'),
  })
  .strict();

export type LspInspectInput = z.infer<typeof LspInspectInputSchema>;

export const ExecuteCommandInputSchema = z
  .object({
    command: z
      .string()
      .min(1)
      .max(10_000)
      .describe('Shell command passed verbatim to `-c`; NO sandbox'),
    cwd: z
      .string()
      .optional()
      .describe('Start directory, absolute or root-relative; must resolve inside an open folder'),
    root: z
      .string()
      .optional()
      .describe('Open-folder name/id; required only with multiple folders'),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(600_000)
      .optional()
      .describe('Process-tree timeout ms (default 120000, max 600000)'),
  })
  .strict();

export type ExecuteCommandInput = z.infer<typeof ExecuteCommandInputSchema>;

// ============================================================================
// Persistent Command Session Tool Schemas
// ============================================================================

const CommandSessionRootSchema = z
  .string()
  .min(1)
  .max(500)
  .optional()
  .describe('Open folder name or durable id; omit when only one folder is open');

const CommandSessionIdSchema = z
  .string()
  .min(1)
  .max(200)
  .describe('Opaque session id returned by start or list');

export const InspectCommandSessionsInputSchema = z
  .object({
    operation: z
      .discriminatedUnion('action', [
        z.object({ action: z.literal('list') }).strict(),
        z
          .object({
            action: z.literal('read'),
            cursor: z
              .number()
              .int()
              .min(-1)
              .optional()
              .describe(
                'Absolute read cursor; omit for retained output or use -1 for the live tail'
              ),
            sessionId: CommandSessionIdSchema,
          })
          .strict(),
      ])
      .describe('Exactly one inspection operation and only its valid fields'),
    root: CommandSessionRootSchema,
  })
  .strict();

export type InspectCommandSessionsInput = z.infer<typeof InspectCommandSessionsInputSchema>;

export const ManageCommandSessionInputSchema = z
  .object({
    operation: z
      .discriminatedUnion('action', [
        z
          .object({
            action: z.literal('start'),
            cols: z.number().int().min(1).max(5000).optional(),
            command: z.string().min(1).max(10_000).describe('Shell command to start'),
            cwd: z
              .string()
              .max(4096)
              .optional()
              .describe('Absolute or workspace-relative directory inside the selected root'),
            rows: z.number().int().min(1).max(5000).optional(),
          })
          .strict(),
        z
          .object({
            action: z.literal('write'),
            data: z.string().min(1).max(100_000).describe('Text to write verbatim'),
            sessionId: CommandSessionIdSchema,
          })
          .strict(),
        z.object({ action: z.literal('stop'), sessionId: CommandSessionIdSchema }).strict(),
        z.object({ action: z.literal('remove'), sessionId: CommandSessionIdSchema }).strict(),
      ])
      .describe('Exactly one process-control operation and only its valid fields'),
    root: CommandSessionRootSchema,
  })
  .strict();

export type ManageCommandSessionInput = z.infer<typeof ManageCommandSessionInputSchema>;

// ============================================================================
// Manage Task List Tool Schema
// ============================================================================

const ManageTaskListItemSchema = z
  .object({
    activeForm: z
      .string()
      .min(1)
      .max(500)
      .describe('Present-tense in-progress label, e.g. "Implementing the parser"'),
    content: z
      .string()
      .min(1)
      .max(500)
      .describe('Imperative task label, e.g. "Implement the parser"'),
    status: z
      .enum(['pending', 'in_progress', 'completed'])
      .describe('Task status; keep exactly one task in_progress'),
  })
  .strict();

export const ManageTaskListInputSchema = z
  .object({
    tasks: z
      .array(ManageTaskListItemSchema)
      .max(50)
      .describe(
        'The full task list to store (whole-list replace — pass the entire desired list every call). Maximum 50 tasks.'
      ),
  })
  .strict();

export type ManageTaskListInput = z.infer<typeof ManageTaskListInputSchema>;

// ============================================================================
// Submit Plan Tool Schema (suspending tool)
// ============================================================================

const SubmitPlanStepSchema = z
  .object({
    detail: z
      .string()
      .max(2000)
      .optional()
      .describe('Optional elaboration of the step (what/why/how).'),
    title: z.string().min(1).max(500).describe('Short imperative step title.'),
  })
  .strict();

export const SubmitPlanInputSchema = z
  .object({
    overview: z
      .string()
      .min(1)
      .max(4000)
      .describe('One or two paragraphs summarizing the plan and its goal.'),
    risks: z
      .string()
      .max(4000)
      .optional()
      .describe('Optional risks, tradeoffs, or things that could go wrong.'),
    steps: z.array(SubmitPlanStepSchema).min(1).max(30).describe('Ordered implementation steps.'),
    title: z.string().min(1).max(300).describe('Short title for the plan.'),
    verification: z
      .string()
      .max(4000)
      .optional()
      .describe('Optional how-to-verify: tests, checks, or acceptance criteria.'),
  })
  .strict();

export type SubmitPlanInput = z.infer<typeof SubmitPlanInputSchema>;

// ============================================================================
// Ask User Tool Schema (suspending tool)
// ============================================================================

const AskUserOptionSchema = z
  .object({
    description: z
      .string()
      .max(1000)
      .optional()
      .describe('Optional context for the option (does not change the answer value).'),
    label: z.string().min(1).max(500).describe('Option label; the value returned when chosen.'),
  })
  .strict();

export const AskUserInputSchema = z
  .object({
    options: z
      .array(AskUserOptionSchema)
      .min(1)
      .max(10)
      .optional()
      .describe('Optional choices. Omit for a free-text question.'),
    question: z.string().min(1).max(2000).describe('The clear, specific question to ask the user.'),
    selectionMode: z
      .enum(['single_select', 'multi_select'])
      .optional()
      .describe('How many options the user may pick. Requires options; defaults to single_select.'),
  })
  .strict();

export type AskUserInput = z.infer<typeof AskUserInputSchema>;

export const NATIVE_TOOL_INPUT_SCHEMAS = {
  [NATIVE_TOOL_ID.askUser]: AskUserInputSchema,
  [NATIVE_TOOL_ID.deleteWorkspaceFile]: DeleteWorkspaceFileInputSchema,
  [NATIVE_TOOL_ID.executeCommand]: ExecuteCommandInputSchema,
  [NATIVE_TOOL_ID.findWorkspaceSymbol]: FindWorkspaceSymbolInputSchema,
  [NATIVE_TOOL_ID.globWorkspace]: GlobWorkspaceInputSchema,
  [NATIVE_TOOL_ID.grepSearch]: GrepSearchInputSchema,
  [NATIVE_TOOL_ID.hybridSearch]: HybridSearchInputSchema,
  [NATIVE_TOOL_ID.inspectCommandSessions]: InspectCommandSessionsInputSchema,
  [NATIVE_TOOL_ID.listEmbeddingSpaces]: ListEmbeddingSetsInputSchema,
  [NATIVE_TOOL_ID.listWorkspaceContext]: ListWorkspaceContextInputSchema,
  [NATIVE_TOOL_ID.lspInspect]: LspInspectInputSchema,
  [NATIVE_TOOL_ID.manageCommandSession]: ManageCommandSessionInputSchema,
  [NATIVE_TOOL_ID.manageTaskList]: ManageTaskListInputSchema,
  [NATIVE_TOOL_ID.queryEmbeddingSpace]: QueryEmbeddingSpaceInputSchema,
  [NATIVE_TOOL_ID.readToolOutputArtifact]: ReadToolOutputArtifactCursorInputSchema,
  [NATIVE_TOOL_ID.readWorkspaceContext]: ReadWorkspaceContextInputSchema,
  [NATIVE_TOOL_ID.readWorkspaceDirectory]: ReadWorkspaceDirectoryInputSchema,
  [NATIVE_TOOL_ID.readWorkspaceFile]: ReadWorkspaceFileInputSchema,
  [NATIVE_TOOL_ID.renameWorkspaceFile]: RenameWorkspaceFileInputSchema,
  [NATIVE_TOOL_ID.stringReplaceWorkspaceFile]: StringReplaceWorkspaceFileInputSchema,
  [NATIVE_TOOL_ID.submitPlan]: SubmitPlanInputSchema,
  [NATIVE_TOOL_ID.updateWorkspaceContextSelection]: UpdateWorkspaceContextSelectionInputSchema,
  [NATIVE_TOOL_ID.updateWorkspaceTapestrySelections]: UpdateWorkspaceTapestrySelectionsInputSchema,
  [WEB_EXTRACT_TOOL_ID]: WebExtractInputSchema,
  [WEB_SEARCH_TOOL_ID]: WebSearchInputSchema,
  [NATIVE_TOOL_ID.writeWorkspaceFile]: WriteWorkspaceFileInputSchema,
} as const satisfies Record<DesktopNativeToolId, z.ZodSchema>;

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
      issues: res.error.issues.map((issue) => formatZodIssue(issue)),
      ok: false,
    };
  }
  return { data: res.data, ok: true };
}

export function validateToolInput(
  name: string,
  params: Record<string, unknown> | undefined
): { ok: true; data: unknown } | { ok: false; issues: string[] } {
  try {
    const schema = isDesktopNativeToolId(name) ? NATIVE_TOOL_INPUT_SCHEMAS[name] : undefined;
    if (schema) {
      return parseWithSchema(schema, params);
    }
    // Only canonical BrainStrike-native tool IDs are validated here.
    // Runtime-discovered MCP tools must keep their server-provided names and are
    // forwarded without local aliasing or fallback validation.
    return { data: params ?? {}, ok: true };
  } catch (err) {
    return { issues: [err instanceof Error ? err.message : String(err)], ok: false };
  }
}
