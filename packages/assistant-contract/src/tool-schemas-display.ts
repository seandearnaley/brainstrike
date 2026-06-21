/**
 * Tool Schema Display Metadata
 *
 * Browser-safe parameter definitions for native tools.
 * These are simplified representations of the Zod schemas for UI display.
 */

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
  toolId: string;
}

/**
 * Native tool schema display information.
 * This is a browser-safe representation of the Zod schemas.
 */
export const NATIVE_TOOL_SCHEMAS: Record<string, ToolSchemaDisplay> = {
  'brainstrike.readWorkspaceFile': {
    toolId: 'brainstrike.readWorkspaceFile',
    description:
      'Read a workspace file. Supports line ranges and output truncation for token efficiency. Pass `root` to choose the folder when multiple are open.',
    parameters: [
      {
        name: 'path',
        type: 'string',
        description: 'Workspace-relative file path to read',
        required: true,
        minLength: 1,
      },
      {
        name: 'root',
        type: 'string',
        description:
          'Folder name or id to read from when multiple folders are open (omit when one)',
        required: false,
      },
      {
        name: 'startLine',
        type: 'number',
        description: '1-based starting line (inclusive)',
        required: false,
        min: 1,
      },
      {
        name: 'endLine',
        type: 'number',
        description: '1-based ending line (inclusive)',
        required: false,
        min: 1,
      },
      {
        name: 'maxChars',
        type: 'number',
        description: 'Maximum characters to return before truncating',
        required: false,
        default: 12_000,
        min: 200,
        max: 50_000,
      },
    ],
    returns:
      'File content payload with metadata, including truncation status and approximate token count',
  },

  'brainstrike.writeWorkspaceFile': {
    toolId: 'brainstrike.writeWorkspaceFile',
    description:
      'Write or create a file in the selected workspace root. Overwrites any existing content and creates missing parent directories. Workspace-scoped: the path can never escape the open folder. Requires approval (edit-risk).',
    parameters: [
      {
        name: 'path',
        type: 'string',
        description: 'Workspace-relative file path to write (parent directories are created)',
        required: true,
        minLength: 1,
      },
      {
        name: 'content',
        type: 'string',
        description: 'Full UTF-8 file content to write, up to ~2 MB (overwrites any existing file)',
        required: true,
        maxLength: 8_000_000,
      },
      {
        name: 'root',
        type: 'string',
        description: 'Folder name or id to write to when multiple folders are open (omit when one)',
        required: false,
      },
    ],
    returns:
      'Write result: the normalized workspace path, bytesWritten, and created (true when a new file was created, false when an existing file was overwritten)',
  },

  'brainstrike.stringReplaceWorkspaceFile': {
    toolId: 'brainstrike.stringReplaceWorkspaceFile',
    description:
      'Surgically edit an existing workspace file: find one oldStr block and replace it with newStr. Matching is fuzzy (exact, then whitespace-tolerant, then close-match) but a single line that matches multiple locations, or no sufficiently close match, is REFUSED rather than guessed. Use an empty newStr to delete the block. Workspace-scoped and edit-risk (requires approval).',
    parameters: [
      {
        name: 'path',
        type: 'string',
        description: 'Workspace-relative file path to edit (the file must already exist)',
        required: true,
        minLength: 1,
      },
      {
        name: 'oldStr',
        type: 'string',
        description:
          'Exact existing block to replace, with enough surrounding context to identify ONE location',
        required: true,
        minLength: 1,
        maxLength: 8_000_000,
      },
      {
        name: 'newStr',
        type: 'string',
        description: 'Replacement text (empty string deletes the matched block)',
        required: true,
        maxLength: 8_000_000,
      },
      {
        name: 'root',
        type: 'string',
        description: 'Folder name or id to edit in when multiple folders are open (omit when one)',
        required: false,
      },
    ],
    returns:
      'Edit result: the normalized workspace path, bytesWritten, matchType (which cascade branch matched), and replaced: true',
  },

  'brainstrike.findWorkspaceSymbol': {
    toolId: 'brainstrike.findWorkspaceSymbol',
    description:
      "Locate a symbol's best-effort enclosing 1-based line range in a workspace file without returning whole-file content.",
    parameters: [
      {
        name: 'path',
        type: 'string',
        description: 'Workspace-relative file path to search',
        required: true,
        minLength: 1,
      },
      {
        name: 'root',
        type: 'string',
        description:
          'Folder name or id to search in when multiple folders are open (omit when one)',
        required: false,
      },
      {
        name: 'query',
        type: 'string',
        description: 'Symbol name or substring to find',
        required: true,
        minLength: 1,
      },
      {
        name: 'maxMatches',
        type: 'number',
        description: 'Maximum matches to return',
        required: false,
        default: 5,
        min: 1,
        max: 20,
      },
      {
        name: 'contextLines',
        type: 'number',
        description: 'Preview lines before/after each match',
        required: false,
        default: 2,
        min: 0,
        max: 10,
      },
    ],
    returns:
      'Matched symbols with best-effort enclosing 1-based line ranges and small preview snippets (no whole-file content)',
  },

  'brainstrike.readWorkspaceDirectory': {
    toolId: 'brainstrike.readWorkspaceDirectory',
    description:
      'List workspace directory entries in a compact format with bounded depth and entry limits.',
    parameters: [
      {
        name: 'path',
        type: 'string',
        description: 'Directory path to list (defaults to workspace root)',
        required: false,
      },
      {
        name: 'root',
        type: 'string',
        description: 'Folder name or id to list when multiple folders are open (omit when one)',
        required: false,
      },
      {
        name: 'depth',
        type: 'number',
        description: 'Maximum directory depth to traverse',
        required: false,
        default: 1,
        min: 0,
        max: 5,
      },
      {
        name: 'maxEntries',
        type: 'number',
        description: 'Maximum entries to return',
        required: false,
        default: 150,
        min: 1,
        max: 500,
      },
      {
        name: 'includeFiles',
        type: 'boolean',
        description: 'Include file entries',
        required: false,
        default: true,
      },
      {
        name: 'includeDirectories',
        type: 'boolean',
        description: 'Include directory entries',
        required: false,
        default: true,
      },
      {
        name: 'includeHidden',
        type: 'boolean',
        description: 'Include hidden files and directories',
        required: false,
        default: false,
      },
      {
        name: 'detail',
        type: 'boolean',
        description: 'Include per-entry size and depth metadata (default: path + type only)',
        required: false,
        default: false,
      },
      {
        name: 'offset',
        type: 'number',
        description: 'Skip this many entries to continue a truncated listing',
        required: false,
        default: 0,
        min: 0,
        max: 5000,
      },
    ],
    returns:
      'Compact entries (self-bounded to the tool output budget) with totals, truncation flag, and a continuation hint',
  },

  'brainstrike.listWorkspaceContext': {
    toolId: 'brainstrike.listWorkspaceContext',
    description:
      'Inspect the open workspace roots, the selected context, and the workspace index hint without returning file contents. Lists every open folder (name + id) so you can pass a `root` qualifier to the read/search tools. Compact summary by default; detail: true adds per-file Tapestry ranges. Use this before reading selected files.',
    parameters: [
      {
        name: 'detail',
        type: 'boolean',
        description:
          'Include full curated-context metadata with per-file Tapestry ranges (default: compact summary)',
        required: false,
        default: false,
      },
      {
        name: 'offset',
        type: 'number',
        description: 'Skip this many selected file paths to continue a truncated listing',
        required: false,
        default: 0,
        min: 0,
        max: 10_000,
      },
      {
        name: 'includeTokenEstimates',
        type: 'boolean',
        description: 'Include selected-file token estimates when they are already available',
        required: false,
        default: false,
      },
    ],
    returns:
      'Open workspace roots (workspaceRoots: name + id + path), the primary root path, selected paths, selected count, workspace index hint, and optional metadata',
  },

  'brainstrike.readWorkspaceContext': {
    toolId: 'brainstrike.readWorkspaceContext',
    description:
      'Read selected or explicit workspace files under bounded file, per-file, and token limits. Use after semantic retrieval when exact source is needed.',
    parameters: [
      {
        name: 'filePaths',
        type: 'array',
        description: 'Workspace-relative file paths to read. Defaults to selected context files.',
        required: false,
        arrayItemType: 'string',
      },
      {
        name: 'root',
        type: 'string',
        description:
          'Folder name or id to read from when multiple folders are open (omit when one). Requires explicit filePaths — the selected-context default only applies to the focused folder.',
        required: false,
      },
      {
        name: 'tokenBudget',
        type: 'number',
        description: 'Maximum approximate output tokens for all returned file contents',
        required: false,
        default: 4000,
        min: 1,
        max: 200_000,
      },
      {
        name: 'maxFiles',
        type: 'number',
        description: 'Maximum files to include',
        required: false,
        default: 20,
        min: 1,
        max: 500,
      },
      {
        name: 'maxCharsPerFile',
        type: 'number',
        description: 'Maximum characters to return per file before truncation',
        required: false,
        default: 12_000,
        min: 1,
        max: 50_000,
      },
      {
        name: 'useTapestrySelections',
        type: 'boolean',
        description:
          'Apply selected Tapestry line ranges from the curated workspace context when available',
        required: false,
        default: true,
      },
    ],
    returns:
      'Included file contents plus explicit skipped-file, truncation, and approximate token metadata',
  },

  'brainstrike.updateWorkspaceContextSelection': {
    toolId: 'brainstrike.updateWorkspaceContextSelection',
    description:
      'Bulk update files selected in the workspace context explorer. Use this when curating reusable context for a prompt.',
    parameters: [
      {
        name: 'filePaths',
        type: 'array',
        description: 'Workspace-relative file paths to select',
        required: true,
        arrayItemType: 'string',
        minLength: 1,
      },
      {
        name: 'mode',
        type: 'enum',
        description: 'Selection update strategy',
        required: false,
        default: 'add',
        enumValues: ['replace', 'add', 'remove'],
      },
      {
        name: 'folderId',
        type: 'string',
        description: 'Optional folder id for multi-root workspaces',
        required: false,
      },
      {
        name: 'root',
        type: 'string',
        description:
          'Folder name or id to curate when multiple folders are open (omit when one). The selection applies to that folder even if it is not the focused one.',
        required: false,
      },
    ],
    returns: 'Selection update result with applied and skipped paths',
  },

  'brainstrike.updateWorkspaceTapestrySelections': {
    toolId: 'brainstrike.updateWorkspaceTapestrySelections',
    description:
      'Create, update, or clear Tapestry line ranges for curated workspace context files. Ranges are 1-based and inclusive.',
    parameters: [
      {
        name: 'updates',
        type: 'array',
        description:
          'Per-file range updates: each item has path and ranges with startLine/endLine/isActive',
        required: true,
        arrayItemType: 'object',
        minLength: 1,
      },
      {
        name: 'mode',
        type: 'enum',
        description: 'Range update strategy per file',
        required: false,
        default: 'replace',
        enumValues: ['replace', 'add', 'clear'],
      },
      {
        name: 'folderId',
        type: 'string',
        description: 'Optional folder id for multi-root workspaces',
        required: false,
      },
      {
        name: 'selectFiles',
        type: 'boolean',
        description: 'Also add affected files to the workspace context selection',
        required: false,
        default: true,
      },
    ],
    returns: 'Tapestry update result with applied and skipped file metadata',
  },

  'brainstrike.listEmbeddingSpaces': {
    toolId: 'brainstrike.listEmbeddingSpaces',
    description:
      'List available embedding spaces and identify the configured workspace index. Use this when you need to inspect non-default embedding spaces or coverage.',
    parameters: [
      {
        name: 'includeStats',
        type: 'boolean',
        description: 'Include optional chunk coverage statistics',
        required: false,
        default: false,
      },
      {
        name: 'workspaceIndexOnly',
        type: 'boolean',
        description: 'Only return the embedding space configured as the current workspace index',
        required: false,
        default: false,
      },
    ],
    returns:
      'Embedding spaces with model, dimensions, distance, workspace-index recommendation flags, and optional coverage stats',
  },

  'brainstrike.queryEmbeddingSpace': {
    toolId: 'brainstrike.queryEmbeddingSpace',
    description:
      'Query semantic workspace context. Omit embeddingSetId for codebase searches to use the Workspace Index; provide embeddingSetId only to query a specific non-default embedding space.',
    parameters: [
      {
        name: 'embeddingSetId',
        type: 'string',
        description:
          'Optional embedding space ID returned by listEmbeddingSpaces; omit for Workspace Index codebase searches',
        required: false,
        minLength: 1,
      },
      {
        name: 'query',
        type: 'string',
        description: 'Semantic retrieval query text',
        required: true,
        minLength: 1,
        maxLength: 2000,
      },
      {
        name: 'tokenBudget',
        type: 'number',
        description: 'Maximum approximate tokens to pack into the retrieval result',
        required: false,
        default: 4000,
        min: 1,
        max: 200_000,
      },
      {
        name: 'limit',
        type: 'number',
        description: 'Maximum candidate chunks to retrieve',
        required: false,
        default: 20,
        min: 1,
        max: 100,
      },
      {
        name: 'threshold',
        type: 'number',
        description: 'Minimum similarity threshold',
        required: false,
        default: 0.3,
        min: 0,
        max: 1,
      },
      {
        name: 'filePaths',
        type: 'array',
        description: 'Optional workspace-relative file paths to constrain retrieval',
        required: false,
        arrayItemType: 'string',
      },
      {
        name: 'root',
        type: 'string',
        description:
          'Optional folder name or id to scope retrieval to one open folder (omit to search all; results are labelled with their root)',
        required: false,
      },
    ],
    returns:
      'Packed semantic chunks with source line ranges, offsets, chunk metadata (incl. rootId/rootName), budget, and skipped counts',
  },

  'brainstrike.grepSearch': {
    toolId: 'brainstrike.grepSearch',
    description:
      "Grep indexed file content for an exact string or regex. Default 'files' mode surveys matching file paths; 'content' mode returns path:line matches with context.",
    parameters: [
      {
        name: 'pattern',
        type: 'string',
        description: 'Exact text (default) or JavaScript regex to find',
        required: true,
        minLength: 2,
        maxLength: 500,
      },
      {
        name: 'isRegex',
        type: 'boolean',
        description: 'Treat pattern as a JavaScript regular expression',
        required: false,
        default: false,
      },
      {
        name: 'caseSensitive',
        type: 'boolean',
        description: 'Case-sensitive matching',
        required: false,
        default: false,
      },
      {
        name: 'filePaths',
        type: 'array',
        description: 'Restrict the search to specific indexed file paths',
        required: false,
        arrayItemType: 'string',
      },
      {
        name: 'root',
        type: 'string',
        description:
          'Optional folder name or id to scope the search to one open folder (omit to search all; results are labelled with their root)',
        required: false,
      },
      {
        name: 'contextLines',
        type: 'number',
        description: "Lines of context before/after each match in 'content' mode",
        required: false,
        default: 1,
        min: 0,
        max: 5,
      },
      {
        name: 'maxResults',
        type: 'number',
        description: "Maximum 'content' matches to return",
        required: false,
        default: 50,
        min: 1,
        max: 200,
      },
      {
        name: 'outputMode',
        type: 'string',
        description:
          "'files' (default) lists matching file paths with match counts; 'content' returns line-level matches with context",
        required: false,
        default: 'files',
      },
      {
        name: 'offset',
        type: 'number',
        description: 'Skip this many files/matches to continue a truncated result',
        required: false,
        default: 0,
        min: 0,
        max: 2000,
      },
    ],
    returns:
      "'files' mode: matching file paths with per-file match counts. 'content' mode: path, 1-based line, line text, and context lines. Both self-bound to the tool output budget with totals, truncation flags, and a continuation hint",
  },

  'brainstrike.globWorkspace': {
    toolId: 'brainstrike.globWorkspace',
    description:
      'Enumerate workspace files whose workspace-relative path matches a glob pattern (e.g. **/*.test.ts, src/**/*.tsx, **/package.json). Walks the open folder(s) on disk, applying the same exclusions the workspace indexer uses (.git, node_modules, dist/build output, lockfiles, generated/minified artifacts). Read-only.',
    parameters: [
      {
        name: 'pattern',
        type: 'string',
        description:
          'Glob matched against workspace-relative paths. A bare pattern with no leading "**/" or "/" matches at any depth.',
        required: true,
        minLength: 1,
        maxLength: 500,
      },
      {
        name: 'root',
        type: 'string',
        description:
          'Optional folder name or id to scope the walk to one open folder (omit to enumerate all; results are labelled with their root)',
        required: false,
      },
      {
        name: 'limit',
        type: 'number',
        description: 'Maximum matching paths to return',
        required: false,
        default: 200,
        min: 1,
        max: 1000,
      },
      {
        name: 'offset',
        type: 'number',
        description: 'Skip this many matches to continue a truncated result',
        required: false,
        default: 0,
        min: 0,
        max: 100_000,
      },
      {
        name: 'includeIgnored',
        type: 'boolean',
        description:
          'Include files normally excluded (.git, node_modules, build output, lockfiles, generated/minified artifacts)',
        required: false,
        default: false,
      },
    ],
    returns:
      'Matching workspace-relative paths (each labelled with its root), self-bound to the tool output budget, with totals, a truncation flag, and a continuation hint',
  },

  'brainstrike.webSearch': {
    toolId: 'brainstrike.webSearch',
    description:
      'Search the web via Tavily for current docs, APIs, error messages, and library usage you do not already know. SENDS YOUR QUERY TO AN EXTERNAL SERVICE (Tavily): never include secrets or private workspace contents. Requires a Tavily API key configured in Settings; when no key is set the tool returns a clear "unavailable, add a key" message instead of failing the run.',
    parameters: [
      {
        name: 'query',
        type: 'string',
        description: 'The web search query (sent to Tavily, an external service)',
        required: true,
        minLength: 2,
        maxLength: 400,
      },
      {
        name: 'maxResults',
        type: 'number',
        description: 'Maximum number of results to return',
        required: false,
        default: 5,
        min: 1,
        max: 10,
      },
    ],
    returns:
      'A list of results (title, url, snippet) self-bound to the tool output budget, with a truncation flag and continuation hint. When no Tavily key is configured, an available: false result with an actionable message. On error/timeout, a non-fatal error result (the run continues).',
  },

  'brainstrike.executeCommand': {
    toolId: 'brainstrike.executeCommand',
    description:
      "Run an arbitrary shell command on the user's machine (e.g. pnpm test, git status, a build). This is ARBITRARY COMMAND EXECUTION with NO sandbox: a command can read or change anything the user can. By default the call suspends for the user's per-call approval before running (execute resolves to 'ask'); the user can let it run unprompted or deny it entirely. The command starts in the selected workspace root (pin it elsewhere with cwd, which must still resolve inside an open folder) and runs in the user's shell. On timeout or cancellation the ENTIRE process tree is killed so nothing is left running. Prefer non-destructive commands.",
    parameters: [
      {
        name: 'command',
        type: 'string',
        description:
          'The shell command line, passed verbatim to the shell as `-c command`. Arbitrary execution, no sandbox.',
        required: true,
        minLength: 1,
        maxLength: 10_000,
      },
      {
        name: 'root',
        type: 'string',
        description:
          'Optional folder name or id to choose which open folder to start in (omit when only one is open)',
        required: false,
      },
      {
        name: 'cwd',
        type: 'string',
        description:
          'Optional start directory (absolute or relative to the root) that MUST resolve inside an open folder. Defaults to the workspace root.',
        required: false,
      },
      {
        name: 'timeoutMs',
        type: 'number',
        description:
          'Kill the whole process tree after this many milliseconds; the result reports timedOut: true',
        required: false,
        default: 120_000,
        min: 1,
        max: 600_000,
      },
    ],
    returns:
      'exitCode (null when killed by signal), the terminating signal, a budget-bounded tail of stdout and stderr (truncated flag + hint when trimmed), durationMs, timedOut, and the resolved cwd',
  },
};

/**
 * Get schema display info for a tool.
 */
export function getToolSchemaDisplay(toolId: string): ToolSchemaDisplay | undefined {
  return NATIVE_TOOL_SCHEMAS[toolId];
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
