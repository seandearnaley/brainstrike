/**
 * Tool Schema Display Metadata
 *
 * Browser-safe parameter definitions for native tools.
 * These are simplified representations of the Zod schemas for UI display.
 */

import { isNativeToolId, NATIVE_TOOL_ID, type NativeToolId } from './native-tool-catalog.js';
import { WEB_EXTRACT_TOOL_ID, WEB_SEARCH_TOOL_ID } from './tool-categories.js';

/**
 * Parameter type for display purposes.
 */
export type ParameterType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'enum';

/**
 * Single parameter definition for UI display.
 */
export interface ToolParameterDisplay {
  arrayItemType?: ParameterType;
  default?: unknown;
  description: string;
  enumValues?: string[];
  max?: number;
  maxLength?: number;
  min?: number;
  minLength?: number;
  name: string;
  required: boolean;
  type: ParameterType;
}

/**
 * Complete schema display info for a tool.
 */
export interface ToolSchemaDisplay {
  description: string;
  parameters: ToolParameterDisplay[];
  returns: string;
  toolId: NativeToolId;
}

/**
 * Native tool schema display information.
 * This is a browser-safe representation of the Zod schemas.
 */
export const NATIVE_TOOL_SCHEMAS: Record<NativeToolId, ToolSchemaDisplay> = {
  'brainstrike.askUser': {
    description:
      'Ask the user a clarifying question and wait for their answer; the run pauses until they respond. Provide options for a structured choice (set selectionMode to multi_select to allow several), or omit options for a free-text question.',
    parameters: [
      {
        description: 'The clear, specific question to ask the user.',
        maxLength: 2000,
        minLength: 1,
        name: 'question',
        required: true,
        type: 'string',
      },
      {
        arrayItemType: 'object',
        description:
          'Optional choices; each has a label and optional description. Omit for free-text.',
        max: 10,
        name: 'options',
        required: false,
        type: 'array',
      },
      {
        description:
          'How many options the user may pick. Requires options; defaults to single_select.',
        enumValues: ['single_select', 'multi_select'],
        name: 'selectionMode',
        required: false,
        type: 'enum',
      },
    ],
    returns: "The user's answer as a string (multi-select answers are comma-joined).",
    toolId: 'brainstrike.askUser',
  },

  'brainstrike.deleteWorkspaceFile': {
    description:
      'Delete a single file from the selected workspace root. FILES ONLY — a directory path is refused (use executeCommand for directory removal). Workspace-scoped: the path can never escape the open folder. Removes the file from the workspace index when it was indexed. Requires approval (edit-risk).',
    parameters: [
      {
        description: 'Workspace-relative file path to delete (the file must already exist)',
        minLength: 1,
        name: 'path',
        required: true,
        type: 'string',
      },
      {
        description:
          'Folder name or id to delete from when multiple folders are open (omit when one)',
        name: 'root',
        required: false,
        type: 'string',
      },
    ],
    returns:
      'Delete result: ok: true, the normalized workspace path, rootName, and indexInvalidated (true when the file had workspace-index rows that were removed)',
    toolId: 'brainstrike.deleteWorkspaceFile',
  },

  'brainstrike.executeCommand': {
    description:
      "Run an arbitrary shell command on the user's machine (e.g. pnpm test, git status, a build). This is ARBITRARY COMMAND EXECUTION with NO sandbox: a command can read or change anything the user can. By default the call suspends for the user's per-call approval before running (execute resolves to 'ask'); the user can let it run unprompted or deny it entirely. The command starts in the selected workspace root (pin it elsewhere with cwd, which must still resolve inside an open folder) and runs in the user's shell. On timeout or cancellation the ENTIRE process tree is killed so nothing is left running. Prefer non-destructive commands.",
    parameters: [
      {
        description:
          'The shell command line, passed verbatim to the shell as `-c command`. Arbitrary execution, no sandbox.',
        maxLength: 10_000,
        minLength: 1,
        name: 'command',
        required: true,
        type: 'string',
      },
      {
        description:
          'Optional folder name or id to choose which open folder to start in (omit when only one is open)',
        name: 'root',
        required: false,
        type: 'string',
      },
      {
        description:
          'Optional start directory (absolute or relative to the root) that MUST resolve inside an open folder. Defaults to the workspace root.',
        name: 'cwd',
        required: false,
        type: 'string',
      },
      {
        default: 120_000,
        description:
          'Kill the whole process tree after this many milliseconds; the result reports timedOut: true',
        max: 600_000,
        min: 1,
        name: 'timeoutMs',
        required: false,
        type: 'number',
      },
    ],
    returns:
      'exitCode (null when killed by signal), the terminating signal, a budget-bounded tail of stdout and stderr (truncated flag + hint when trimmed), durationMs, timedOut, and the resolved cwd',
    toolId: 'brainstrike.executeCommand',
  },

  'brainstrike.findWorkspaceSymbol': {
    description:
      "Locate a symbol's best-effort enclosing 1-based line range in a workspace file without returning whole-file content.",
    parameters: [
      {
        description: 'Workspace-relative file path to search',
        minLength: 1,
        name: 'path',
        required: true,
        type: 'string',
      },
      {
        description:
          'Folder name or id to search in when multiple folders are open (omit when one)',
        name: 'root',
        required: false,
        type: 'string',
      },
      {
        description: 'Symbol name or substring to find',
        minLength: 1,
        name: 'query',
        required: true,
        type: 'string',
      },
      {
        default: 5,
        description: 'Maximum matches to return',
        max: 20,
        min: 1,
        name: 'maxMatches',
        required: false,
        type: 'number',
      },
      {
        default: 2,
        description: 'Preview lines before/after each match',
        max: 10,
        min: 0,
        name: 'contextLines',
        required: false,
        type: 'number',
      },
    ],
    returns:
      'Matched symbols with best-effort enclosing 1-based line ranges and small preview snippets (no whole-file content)',
    toolId: 'brainstrike.findWorkspaceSymbol',
  },

  'brainstrike.globWorkspace': {
    description:
      'Enumerate workspace files whose workspace-relative path matches a glob pattern (e.g. **/*.test.ts, src/**/*.tsx, **/package.json). Walks the open folder(s) on disk, applying the same exclusions the workspace indexer uses (.git, node_modules, dist/build output, lockfiles, generated/minified artifacts). Read-only.',
    parameters: [
      {
        description:
          'Glob matched against workspace-relative paths. A bare pattern with no leading "**/" or "/" matches at any depth.',
        maxLength: 500,
        minLength: 1,
        name: 'pattern',
        required: true,
        type: 'string',
      },
      {
        description:
          'Optional folder name or id to scope the walk to one open folder (omit to enumerate all; results are labelled with their root)',
        name: 'root',
        required: false,
        type: 'string',
      },
      {
        default: 200,
        description: 'Maximum matching paths to return',
        max: 1000,
        min: 1,
        name: 'limit',
        required: false,
        type: 'number',
      },
      {
        default: 0,
        description: 'Skip this many matches to continue a truncated result',
        max: 100_000,
        min: 0,
        name: 'offset',
        required: false,
        type: 'number',
      },
      {
        default: false,
        description:
          'Include files normally excluded (.git, node_modules, build output, lockfiles, generated/minified artifacts)',
        name: 'includeIgnored',
        required: false,
        type: 'boolean',
      },
    ],
    returns:
      'Matching workspace-relative paths (each labelled with its root), self-bound to the tool output budget, with totals, a truncation flag, and a continuation hint',
    toolId: 'brainstrike.globWorkspace',
  },

  'brainstrike.grepSearch': {
    description:
      "Grep indexed file content for an exact string or regex. Default 'files' mode surveys matching file paths; 'content' mode returns path:line matches with context.",
    parameters: [
      {
        description: 'Exact text (default) or JavaScript regex to find',
        maxLength: 500,
        minLength: 2,
        name: 'pattern',
        required: true,
        type: 'string',
      },
      {
        default: false,
        description: 'Treat pattern as a JavaScript regular expression',
        name: 'isRegex',
        required: false,
        type: 'boolean',
      },
      {
        default: false,
        description: 'Case-sensitive matching',
        name: 'caseSensitive',
        required: false,
        type: 'boolean',
      },
      {
        arrayItemType: 'string',
        description: 'Restrict the search to specific indexed file paths',
        name: 'filePaths',
        required: false,
        type: 'array',
      },
      {
        description:
          'Optional folder name or id to scope the search to one open folder (omit to search all; results are labelled with their root)',
        name: 'root',
        required: false,
        type: 'string',
      },
      {
        default: 1,
        description: "Lines of context before/after each match in 'content' mode",
        max: 5,
        min: 0,
        name: 'contextLines',
        required: false,
        type: 'number',
      },
      {
        default: 50,
        description: "Maximum 'content' matches to return",
        max: 200,
        min: 1,
        name: 'maxResults',
        required: false,
        type: 'number',
      },
      {
        default: 'files',
        description:
          "'files' (default) lists matching file paths with match counts; 'content' returns line-level matches with context",
        name: 'outputMode',
        required: false,
        type: 'string',
      },
      {
        default: 0,
        description: 'Skip this many files/matches to continue a truncated result',
        max: 2000,
        min: 0,
        name: 'offset',
        required: false,
        type: 'number',
      },
    ],
    returns:
      "'files' mode: matching file paths with per-file match counts. 'content' mode: path, 1-based line, line text, and context lines. Both self-bound to the tool output budget with totals, truncation flags, and a continuation hint",
    toolId: 'brainstrike.grepSearch',
  },

  'brainstrike.hybridSearch': {
    description:
      'Hybrid workspace search: runs semantic (vector) and exact-term (BM25 keyword) search in parallel and fuses the rankings with reciprocal rank fusion. Best default for code/doc retrieval mixing conceptual intent with distinctive terms; omit embeddingSetId to use the Workspace Index.',
    parameters: [
      {
        description: 'Search query text; used for BOTH the semantic and the keyword arm',
        maxLength: 2000,
        minLength: 1,
        name: 'query',
        required: true,
        type: 'string',
      },
      {
        description:
          'Optional embedding space ID returned by listEmbeddingSpaces; omit for Workspace Index searches',
        minLength: 1,
        name: 'embeddingSetId',
        required: false,
        type: 'string',
      },
      {
        default: 20,
        description: 'Maximum fused results to return',
        max: 100,
        min: 1,
        name: 'limit',
        required: false,
        type: 'number',
      },
      {
        default: 1,
        description: 'Weight for the semantic (vector) arm in the fusion',
        max: 2,
        min: 0,
        name: 'vectorWeight',
        required: false,
        type: 'number',
      },
      {
        default: 1,
        description: 'Weight for the exact-term (keyword) arm in the fusion',
        max: 2,
        min: 0,
        name: 'ftsWeight',
        required: false,
        type: 'number',
      },
      {
        default: 0.5,
        description: 'Minimum similarity threshold for the semantic arm',
        max: 1,
        min: 0,
        name: 'vectorThreshold',
        required: false,
        type: 'number',
      },
      {
        arrayItemType: 'string',
        description: 'Optional workspace-relative file paths to constrain the search',
        max: 500,
        name: 'filePaths',
        required: false,
        type: 'array',
      },
      {
        description: 'Filter by chunk type',
        enumValues: ['text', 'code', 'sentence', 'recursive'],
        name: 'chunkType',
        required: false,
        type: 'enum',
      },
      {
        description:
          'Optional folder name or id to scope the search to one open folder (omit to search all)',
        name: 'root',
        required: false,
        type: 'string',
      },
    ],
    returns:
      'Fused ranked chunks with rrfScore, sourceCount, per-arm scores (vectorSimilarity, ftsRank), file paths, and per-arm result counts',
    toolId: 'brainstrike.hybridSearch',
  },
  'brainstrike.inspectCommandSessions': {
    description:
      'Inspect persistent PTY sessions owned by one open workspace root. List and read are bounded pages; sensitive command-session input and output are redacted from durable history.',
    parameters: [
      {
        description:
          'Exactly one operation: {action:"list", offset?}, or {action:"read", sessionId, cursor?}.',
        name: 'operation',
        required: true,
        type: 'object',
      },
      {
        description: 'Optional folder name or durable id; omit when only one folder is open.',
        name: 'root',
        required: false,
        type: 'string',
      },
    ],
    returns:
      'For list: a compact page with totalSessions and nextOffset when truncated. For read: bounded output, nextCursor, availableEndCursor, remaining count, retained buffer boundary, and explicit replay-gap state.',
    toolId: 'brainstrike.inspectCommandSessions',
  },
  'brainstrike.listEmbeddingSpaces': {
    description:
      'List available embedding spaces and identify the configured workspace index. Use this when you need to inspect non-default embedding spaces or coverage.',
    parameters: [
      {
        default: false,
        description: 'Include optional chunk coverage statistics',
        name: 'includeStats',
        required: false,
        type: 'boolean',
      },
      {
        default: false,
        description: 'Only return the embedding space configured as the current workspace index',
        name: 'workspaceIndexOnly',
        required: false,
        type: 'boolean',
      },
    ],
    returns:
      'Embedding spaces with model, dimensions, distance, workspace-index recommendation flags, and optional coverage stats',
    toolId: 'brainstrike.listEmbeddingSpaces',
  },

  'brainstrike.listWorkspaceContext': {
    description:
      'Inspect the open workspace roots, the selected context, and the workspace index hint without returning file contents. Lists every open folder (name + id) so you can pass a `root` qualifier to the read/search tools. Compact summary by default; detail: true adds per-file Tapestry ranges. Use this before reading selected files.',
    parameters: [
      {
        default: false,
        description:
          'Include full curated-context metadata with per-file Tapestry ranges (default: compact summary)',
        name: 'detail',
        required: false,
        type: 'boolean',
      },
      {
        default: 0,
        description: 'Skip this many selected file paths to continue a truncated listing',
        max: 10_000,
        min: 0,
        name: 'offset',
        required: false,
        type: 'number',
      },
      {
        default: false,
        description: 'Include selected-file token estimates when they are already available',
        name: 'includeTokenEstimates',
        required: false,
        type: 'boolean',
      },
    ],
    returns:
      'Open workspace roots (workspaceRoots: name + id + path), the main root path, selected paths, selected count, workspace index hint, and optional metadata',
    toolId: 'brainstrike.listWorkspaceContext',
  },

  'brainstrike.readToolOutputArtifact': {
    description:
      'Read the next bounded UTF-8 page from an oversized tool result retained for the current thread. Pass the prior continuation cursor unchanged.',
    parameters: [
      {
        description:
          'Exact opaque continuation cursor from the previous result. Copy byte-for-byte; never decode, pad, edit, or recreate it.',
        name: 'cursor',
        required: true,
        type: 'string',
      },
      {
        description: 'Optional UTF-8 source-byte page target (4-8000; default 6000).',
        max: 8000,
        min: 4,
        name: 'maxBytes',
        required: false,
        type: 'number',
      },
    ],
    returns:
      'A contiguous byte-addressed page with content, offsetByte, endByte, artifactRef, and nextCursor exactly when bytes remain.',
    toolId: 'brainstrike.readToolOutputArtifact',
  },

  [NATIVE_TOOL_ID.lspInspect]: {
    description:
      "Semantic code inspection at a cursor via a language server (TypeScript/JavaScript). Returns the inferred TYPE (hover), line diagnostics, the symbol's DEFINITION location, and its IMPLEMENTATIONS. Read-only. Returns a clear 'unavailable' note (not an error) for unsupported file types or when no server is available.",
    parameters: [
      {
        description: 'Workspace-relative file path to inspect',
        minLength: 1,
        name: 'path',
        required: true,
        type: 'string',
      },
      {
        description: '1-based line number of the symbol to inspect',
        min: 1,
        name: 'line',
        required: true,
        type: 'number',
      },
      {
        description:
          "The target line's text — or a fragment that occurs exactly once on that line — with a `<<<` cursor marker inserted right before the symbol (exactly one `<<<`), e.g. `const total = <<<computeTotal(items)`",
        minLength: 3,
        name: 'match',
        required: true,
        type: 'string',
      },
      {
        description: 'Optional folder name or id when multiple folders are open (omit when one)',
        name: 'root',
        required: false,
        type: 'string',
      },
    ],
    returns:
      'Up to four groups: hover (type/docs), diagnostics (the inspected line), definition (declaration locations with a one-line preview), and implementation (usage/implementation locations). An available:false note for unsupported file types or when no server is available.',
    toolId: NATIVE_TOOL_ID.lspInspect,
  },

  'brainstrike.manageCommandSession': {
    description:
      'Start, write to, stop, or remove a persistent workspace PTY. Use for servers and interactive commands that must survive one tool call. Arbitrary execution, no sandbox, approval required by default.',
    parameters: [
      {
        description:
          'Exactly one operation: {action:"start", command, cwd?, cols?, rows?}, {action:"write", sessionId, data}, {action:"stop", sessionId}, or {action:"remove", sessionId}.',
        name: 'operation',
        required: true,
        type: 'object',
      },
      {
        description: 'Optional folder name or durable id; omit when only one folder is open.',
        name: 'root',
        required: false,
        type: 'string',
      },
    ],
    returns:
      'Typed session state for start/stop/write, or an explicit removed result. Failures distinguish invalid input, unavailable roots, unknown/cross-root sessions, exited sessions, startup failure, and stop failure.',
    toolId: 'brainstrike.manageCommandSession',
  },

  'brainstrike.manageTaskList': {
    description:
      'Record and update a structured plan for the current thread as a task list. Whole-list replace: pass the full desired list every call. Keep exactly one task in_progress and mark tasks completed as you finish them. The list is re-injected into your instructions each turn and shown to the user as a progress checklist.',
    parameters: [
      {
        arrayItemType: 'object',
        description:
          'The full task list to store (whole-list replace). Each item is { content (imperative label), activeForm (present-tense in-progress label), status: pending | in_progress | completed }. Maximum 50 tasks.',
        max: 50,
        name: 'tasks',
        required: true,
        type: 'array',
      },
    ],
    returns:
      'The stored tasks (with stable server-assigned ids) and a summary of counts by status (total, completed, inProgress, pending)',
    toolId: 'brainstrike.manageTaskList',
  },

  'brainstrike.queryEmbeddingSpace': {
    description:
      'Query semantic workspace context. Omit embeddingSetId for codebase searches to use the Workspace Index; provide embeddingSetId only to query a specific non-default embedding space.',
    parameters: [
      {
        description:
          'Optional embedding space ID returned by listEmbeddingSpaces; omit for Workspace Index codebase searches',
        minLength: 1,
        name: 'embeddingSetId',
        required: false,
        type: 'string',
      },
      {
        description: 'Semantic retrieval query text',
        maxLength: 2000,
        minLength: 1,
        name: 'query',
        required: true,
        type: 'string',
      },
      {
        default: 4000,
        description: 'Maximum approximate tokens to pack into the retrieval result',
        max: 200_000,
        min: 1,
        name: 'tokenBudget',
        required: false,
        type: 'number',
      },
      {
        default: 20,
        description: 'Maximum candidate chunks to retrieve',
        max: 100,
        min: 1,
        name: 'limit',
        required: false,
        type: 'number',
      },
      {
        default: 0.3,
        description: 'Minimum similarity threshold',
        max: 1,
        min: 0,
        name: 'threshold',
        required: false,
        type: 'number',
      },
      {
        arrayItemType: 'string',
        description: 'Optional workspace-relative file paths to constrain retrieval',
        name: 'filePaths',
        required: false,
        type: 'array',
      },
      {
        description:
          'Optional folder name or id to scope retrieval to one open folder (omit to search all; results are labelled with their root)',
        name: 'root',
        required: false,
        type: 'string',
      },
    ],
    returns:
      'Packed semantic chunks with source line ranges, offsets, chunk metadata (incl. rootId/rootName), budget, and skipped counts',
    toolId: 'brainstrike.queryEmbeddingSpace',
  },

  'brainstrike.readWorkspaceContext': {
    description:
      'Read selected or explicit workspace files under bounded file, per-file, and token limits. Use after semantic retrieval when exact source is needed.',
    parameters: [
      {
        arrayItemType: 'string',
        description: 'Workspace-relative file paths to read. Defaults to selected context files.',
        name: 'filePaths',
        required: false,
        type: 'array',
      },
      {
        description:
          'Folder name or id to read from when multiple folders are open (omit when one). Requires explicit filePaths — the selected-context default only applies to the focused folder.',
        name: 'root',
        required: false,
        type: 'string',
      },
      {
        default: 4000,
        description: 'Maximum approximate output tokens for all returned file contents',
        max: 200_000,
        min: 1,
        name: 'tokenBudget',
        required: false,
        type: 'number',
      },
      {
        default: 20,
        description: 'Maximum files to include',
        max: 500,
        min: 1,
        name: 'maxFiles',
        required: false,
        type: 'number',
      },
      {
        default: 12_000,
        description: 'Maximum characters to return per file before truncation',
        max: 50_000,
        min: 1,
        name: 'maxCharsPerFile',
        required: false,
        type: 'number',
      },
      {
        default: true,
        description:
          'Apply selected Tapestry line ranges from the curated workspace context when available',
        name: 'useTapestrySelections',
        required: false,
        type: 'boolean',
      },
    ],
    returns:
      'Included file contents plus explicit skipped-file, truncation, and approximate token metadata',
    toolId: 'brainstrike.readWorkspaceContext',
  },

  'brainstrike.readWorkspaceDirectory': {
    description:
      'List workspace directory entries in a compact format with bounded depth and entry limits.',
    parameters: [
      {
        description: 'Directory path to list (defaults to workspace root)',
        name: 'path',
        required: false,
        type: 'string',
      },
      {
        description: 'Folder name or id to list when multiple folders are open (omit when one)',
        name: 'root',
        required: false,
        type: 'string',
      },
      {
        default: 1,
        description: 'Maximum directory depth to traverse',
        max: 5,
        min: 0,
        name: 'depth',
        required: false,
        type: 'number',
      },
      {
        default: 150,
        description: 'Maximum entries to return',
        max: 500,
        min: 1,
        name: 'maxEntries',
        required: false,
        type: 'number',
      },
      {
        default: true,
        description: 'Include file entries',
        name: 'includeFiles',
        required: false,
        type: 'boolean',
      },
      {
        default: true,
        description: 'Include directory entries',
        name: 'includeDirectories',
        required: false,
        type: 'boolean',
      },
      {
        default: false,
        description: 'Include hidden files and directories',
        name: 'includeHidden',
        required: false,
        type: 'boolean',
      },
      {
        default: false,
        description: 'Include per-entry size and depth metadata (default: path + type only)',
        name: 'detail',
        required: false,
        type: 'boolean',
      },
      {
        default: 0,
        description: 'Skip this many entries to continue a truncated listing',
        max: 5000,
        min: 0,
        name: 'offset',
        required: false,
        type: 'number',
      },
    ],
    returns:
      'Compact entries (self-bounded to the tool output budget) with totals, truncation flag, and a continuation hint',
    toolId: 'brainstrike.readWorkspaceDirectory',
  },
  'brainstrike.readWorkspaceFile': {
    description:
      'Read a workspace file as bounded, line-numbered pages. Pass `nextCursor` back as `cursor` to continue without losing source text. Pass `root` on the first page to choose the folder when multiple are open; the cursor binds later pages to that root.',
    parameters: [
      {
        description: 'Workspace-relative file path; required only for the first page',
        minLength: 1,
        name: 'path',
        required: false,
        type: 'string',
      },
      {
        description:
          'Folder name or id to read from when multiple folders are open; omit on continuation to reuse the cursor-bound root',
        name: 'root',
        required: false,
        type: 'string',
      },
      {
        description:
          'Short thread-scoped handle returned as nextCursor; pass it unchanged with optional maxChars and omit every other field',
        name: 'cursor',
        required: false,
        type: 'string',
      },
      {
        description:
          '1-based starting line (inclusive); omit on continuation unless replaying the original value unchanged',
        min: 1,
        name: 'startLine',
        required: false,
        type: 'number',
      },
      {
        description:
          '1-based ending line (inclusive); omit on continuation unless replaying the original value unchanged',
        min: 1,
        name: 'endLine',
        required: false,
        type: 'number',
      },
      {
        default: 12_000,
        description: 'Maximum characters to return before truncating',
        max: 50_000,
        min: 200,
        name: 'maxChars',
        required: false,
        type: 'number',
      },
    ],
    returns:
      'Line-numbered file page with exact source metadata, truncation status, and nextCursor (null when complete)',
    toolId: 'brainstrike.readWorkspaceFile',
  },

  'brainstrike.renameWorkspaceFile': {
    description:
      'Rename or move a single file within the selected workspace root. FILES ONLY. The destination must NOT already exist (no overwrite — delete the target first if needed). Both paths stay inside ONE open folder (cross-root moves are refused); missing destination parent directories are created. Prefer this over a shell "mv" so the workspace index stays coherent. Requires approval (edit-risk).',
    parameters: [
      {
        description: 'Existing workspace-relative file path to rename/move from',
        minLength: 1,
        name: 'fromPath',
        required: true,
        type: 'string',
      },
      {
        description:
          'Destination workspace-relative file path (must not already exist; parent directories are created)',
        minLength: 1,
        name: 'toPath',
        required: true,
        type: 'string',
      },
      {
        description:
          'Folder name or id to operate in when multiple folders are open (omit when one)',
        name: 'root',
        required: false,
        type: 'string',
      },
    ],
    returns:
      'Rename result: ok: true, the normalized fromPath and toPath, rootName, and indexInvalidated (true when the source path had workspace-index rows that were removed; the destination is re-indexed by the background sync)',
    toolId: 'brainstrike.renameWorkspaceFile',
  },

  'brainstrike.stringReplaceWorkspaceFile': {
    description:
      'Surgically edit an existing workspace file: find one oldStr block and replace it with newStr. Matching is fuzzy (exact, then whitespace-tolerant, then close-match) but a single line that matches multiple locations, or no sufficiently close match, is REFUSED rather than guessed. Use an empty newStr to delete the block. Workspace-scoped and edit-risk (requires approval).',
    parameters: [
      {
        description: 'Workspace-relative file path to edit (the file must already exist)',
        minLength: 1,
        name: 'path',
        required: true,
        type: 'string',
      },
      {
        description:
          'Exact existing block to replace, with enough surrounding context to identify ONE location',
        maxLength: 8_000_000,
        minLength: 1,
        name: 'oldStr',
        required: true,
        type: 'string',
      },
      {
        description: 'Replacement text (empty string deletes the matched block)',
        maxLength: 8_000_000,
        name: 'newStr',
        required: true,
        type: 'string',
      },
      {
        description: 'Folder name or id to edit in when multiple folders are open (omit when one)',
        name: 'root',
        required: false,
        type: 'string',
      },
    ],
    returns:
      'Edit result: the normalized workspace path, bytesWritten, matchType (which cascade branch matched), and replaced: true',
    toolId: 'brainstrike.stringReplaceWorkspaceFile',
  },

  'brainstrike.submitPlan': {
    description:
      'Submit a structured implementation plan for the user to Approve or Reject. The run pauses until the user responds; on rejection their feedback is returned so you can revise and submit again.',
    parameters: [
      {
        description: 'Short title for the plan.',
        maxLength: 300,
        minLength: 1,
        name: 'title',
        required: true,
        type: 'string',
      },
      {
        description: 'One or two paragraphs summarizing the plan and its goal.',
        maxLength: 4000,
        minLength: 1,
        name: 'overview',
        required: true,
        type: 'string',
      },
      {
        arrayItemType: 'object',
        description: 'Ordered implementation steps; each has a title and optional detail.',
        max: 30,
        name: 'steps',
        required: true,
        type: 'array',
      },
      {
        description: 'Optional risks, tradeoffs, or things that could go wrong.',
        maxLength: 4000,
        name: 'risks',
        required: false,
        type: 'string',
      },
      {
        description: 'Optional how-to-verify: tests, checks, or acceptance criteria.',
        maxLength: 4000,
        name: 'verification',
        required: false,
        type: 'string',
      },
    ],
    returns:
      "The user's decision: status approved or rejected, plus optional feedback on rejection.",
    toolId: 'brainstrike.submitPlan',
  },

  'brainstrike.updateWorkspaceContextSelection': {
    description:
      'Bulk update files selected in the workspace context explorer. Use this when curating reusable context for a prompt.',
    parameters: [
      {
        arrayItemType: 'string',
        description: 'Workspace-relative file paths to select',
        minLength: 1,
        name: 'filePaths',
        required: true,
        type: 'array',
      },
      {
        default: 'add',
        description: 'Selection update strategy',
        enumValues: ['replace', 'add', 'remove'],
        name: 'mode',
        required: false,
        type: 'enum',
      },
      {
        description: 'Optional folder id for multi-root workspaces',
        name: 'folderId',
        required: false,
        type: 'string',
      },
      {
        description:
          'Folder name or id to curate when multiple folders are open (omit when one). The selection applies to that folder even if it is not the focused one.',
        name: 'root',
        required: false,
        type: 'string',
      },
    ],
    returns: 'Selection update result with applied and skipped paths',
    toolId: 'brainstrike.updateWorkspaceContextSelection',
  },

  'brainstrike.updateWorkspaceTapestrySelections': {
    description:
      'Create, update, or clear Tapestry line ranges for curated workspace context files. Ranges are 1-based and inclusive.',
    parameters: [
      {
        arrayItemType: 'object',
        description:
          'Per-file range updates: each item has path and ranges with startLine/endLine/isActive',
        minLength: 1,
        name: 'updates',
        required: true,
        type: 'array',
      },
      {
        default: 'replace',
        description: 'Range update strategy per file',
        enumValues: ['replace', 'add', 'clear'],
        name: 'mode',
        required: false,
        type: 'enum',
      },
      {
        description: 'Optional folder id for multi-root workspaces',
        name: 'folderId',
        required: false,
        type: 'string',
      },
      {
        default: true,
        description: 'Also add affected files to the workspace context selection',
        name: 'selectFiles',
        required: false,
        type: 'boolean',
      },
    ],
    returns: 'Tapestry update result with applied and skipped file metadata',
    toolId: 'brainstrike.updateWorkspaceTapestrySelections',
  },

  [WEB_EXTRACT_TOOL_ID]: {
    description:
      'Fetch the readable content of up to 5 public web pages as markdown — the natural follow-up to webSearch results, or for a user-pasted URL. SENDS THE URLS TO AN EXTERNAL EXTRACTION SERVICE (Tavily): never pass internal or private URLs. Non-http(s), credentialed, and private/loopback/link-local URLs are refused server-side before anything is sent, and each refusal is reported per-URL in the result. When no Tavily API key is configured the tool returns a clear "unavailable, add a key" message instead of failing the run.',
    parameters: [
      {
        description: 'Absolute http(s) URLs of public pages to extract (1-5)',
        name: 'urls',
        required: true,
        type: 'array',
      },
    ],
    returns:
      'Complete per-URL extracted markdown content plus exact URLs and a per-URL failed list (refused/unreachable URLs with exact reasons). Larger results provide an exact brainstrike.readToolOutputArtifact continuation cursor instead of clipping or re-fetching. When no Tavily key is configured, an available: false result with an actionable message. On error/timeout, a non-fatal error result (the run continues).',
    toolId: WEB_EXTRACT_TOOL_ID,
  },

  [WEB_SEARCH_TOOL_ID]: {
    description:
      'Search the web for current docs, APIs, error messages, and library usage you do not already know. SENDS YOUR QUERY TO AN EXTERNAL SERVICE: never include secrets or private workspace contents. Uses the model provider\'s built-in web search when available (Anthropic/OpenAI), otherwise Tavily; when neither a provider-native search nor a Tavily API key is configured the tool returns a clear "unavailable, add a key" message instead of failing the run.',
    parameters: [
      {
        description: 'The web search query (sent to an external web-search service)',
        maxLength: 400,
        minLength: 2,
        name: 'query',
        required: true,
        type: 'string',
      },
      {
        default: 5,
        description: 'Maximum number of results to return',
        max: 10,
        min: 1,
        name: 'maxResults',
        required: false,
        type: 'number',
      },
    ],
    returns:
      'A list of results (title, url, snippet) self-bound to the tool output budget, with a truncation flag and continuation hint. When neither a provider-native search nor a Tavily key is available, an available: false result with an actionable message. On error/timeout, a non-fatal error result (the run continues).',
    toolId: WEB_SEARCH_TOOL_ID,
  },

  'brainstrike.writeWorkspaceFile': {
    description:
      'Write or create a file in the selected workspace root. Overwrites any existing content and creates missing parent directories. Workspace-scoped: the path can never escape the open folder. Requires approval (edit-risk).',
    parameters: [
      {
        description: 'Workspace-relative file path to write (parent directories are created)',
        minLength: 1,
        name: 'path',
        required: true,
        type: 'string',
      },
      {
        description: 'Full UTF-8 file content to write, up to ~2 MB (overwrites any existing file)',
        maxLength: 8_000_000,
        name: 'content',
        required: true,
        type: 'string',
      },
      {
        description: 'Folder name or id to write to when multiple folders are open (omit when one)',
        name: 'root',
        required: false,
        type: 'string',
      },
    ],
    returns:
      'Write result: the normalized workspace path, bytesWritten, and created (true when a new file was created, false when an existing file was overwritten)',
    toolId: 'brainstrike.writeWorkspaceFile',
  },
  skill: {
    description:
      "Activate an Agent Skill by name: loads the skill's full SKILL.md instructions into the conversation, plus a listing of its bundled reference/script/asset files. Read-only.",
    parameters: [
      {
        description:
          'The skill name from the available-skills list (or its directory path when two skills share a name).',
        name: 'name',
        required: true,
        type: 'string',
      },
    ],
    returns:
      'The skill instructions (SKILL.md body) followed by listings of its references/, scripts/, and assets/ files; oversized instructions are truncated with an honest note.',
    toolId: 'skill',
  },
  // biome-ignore lint/style/useNamingConvention: Mastra's canonical skill tool id.
  skill_read: {
    description:
      'Read a bundled file from a skill directory (references/, scripts/, or assets/), optionally sliced by line range. Read-only and containment-checked to the skill directory.',
    parameters: [
      {
        description: 'The skill name (or directory path when two skills share a name).',
        name: 'skillName',
        required: true,
        type: 'string',
      },
      {
        description:
          'Path relative to the skill root, e.g. "references/forms.md" or "scripts/fill.py".',
        name: 'path',
        required: true,
        type: 'string',
      },
      {
        description: 'Starting line number (1-indexed); omit to read from the beginning.',
        name: 'startLine',
        required: false,
        type: 'number',
      },
      {
        description: 'Ending line number (1-indexed, inclusive); omit to read to the end.',
        name: 'endLine',
        required: false,
        type: 'number',
      },
    ],
    returns:
      'The file content (or the requested line slice); binary files report their size instead of raw bytes; oversized output is truncated with a line-range hint.',
    toolId: 'skill_read',
  },
  // biome-ignore lint/style/useNamingConvention: Mastra's canonical skill tool id.
  skill_search: {
    description:
      'Search across installed skill instructions and reference files by keyword. Read-only.',
    parameters: [
      {
        description: 'The search query.',
        name: 'query',
        required: true,
        type: 'string',
      },
      {
        arrayItemType: 'string',
        description: 'Optional list of skill names to search within.',
        name: 'skillNames',
        required: false,
        type: 'array',
      },
      {
        description: 'Maximum number of results to return (default 5).',
        name: 'topK',
        required: false,
        type: 'number',
      },
    ],
    returns:
      'Matching snippets labeled with their skill, source file, line range, and relevance score.',
    toolId: 'skill_search',
  },
};

/**
 * Get schema display info for a tool.
 */
export function getToolSchemaDisplay(toolId: string): ToolSchemaDisplay | undefined {
  return isNativeToolId(toolId) ? NATIVE_TOOL_SCHEMAS[toolId] : undefined;
}

/**
 * Generate example JSON input from schema display.
 */
export function generateExampleInput(schema: ToolSchemaDisplay): Record<string, unknown> {
  const example: Record<string, unknown> = {};

  for (const param of schema.parameters) {
    if (param.required) {
      switch (param.type) {
        case 'string':
          example[param.name] = param.enumValues?.[0] ?? `<${param.name}>`;
          break;
        case 'number':
          example[param.name] = param.default ?? param.min ?? 1;
          break;
        case 'boolean':
          example[param.name] = param.default ?? false;
          break;
        case 'array':
          example[param.name] = [];
          break;
        case 'enum':
          example[param.name] = param.enumValues?.[0] ?? '';
          break;
        case 'object':
          example[param.name] = {};
          break;
      }
    }
  }

  return example;
}
