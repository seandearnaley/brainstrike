/**
 * Search Tool Schema Display Metadata
 *
 * Browser-safe parameter definitions for native search and retrieval tools.
 */

import { NATIVE_TOOL_ID } from './native-tool-catalog.js';
import { WEB_EXTRACT_TOOL_ID, WEB_SEARCH_TOOL_ID } from './tool-categories.js';
import type { ToolSchemaDisplay } from './tool-schemas-display.js';

type SearchToolId =
  | 'brainstrike.findWorkspaceSymbol'
  | 'brainstrike.globWorkspace'
  | 'brainstrike.grepSearch'
  | 'brainstrike.hybridSearch'
  | 'brainstrike.listEmbeddingSpaces'
  | typeof NATIVE_TOOL_ID.lspInspect
  | 'brainstrike.queryDiagnostics'
  | 'brainstrike.queryEmbeddingSpace'
  | 'brainstrike.querySelf'
  | typeof WEB_EXTRACT_TOOL_ID
  | typeof WEB_SEARCH_TOOL_ID
  | 'skill_read'
  | 'skill_search';

export const SEARCH_TOOL_SCHEMAS: Record<SearchToolId, ToolSchemaDisplay> = {
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
        enumValues: ['files', 'content'],
        name: 'outputMode',
        required: false,
        type: 'enum',
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
          'Prefer the unique identifier itself, e.g. `computeTotal` (cursor at its first character). If it repeats on the line, use a unique fragment with exactly one `<<<` before the intended occurrence, e.g. `const total = <<<computeTotal(items)`',
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

  'brainstrike.queryDiagnostics': {
    description:
      'Read bounded durable diagnostic events from the local Flight Recorder, either as newest rows or grouped recurring fingerprints.',
    parameters: [
      {
        description: 'Exact diagnostic fingerprint',
        maxLength: 256,
        minLength: 1,
        name: 'fingerprint',
        required: false,
        type: 'string',
      },
      {
        default: 50,
        description: 'Maximum events or groups to inspect (hard max 200)',
        max: 200,
        min: 1,
        name: 'limit',
        required: false,
        type: 'number',
      },
      {
        description: 'events returns newest rows; fingerprints groups recurring failures',
        enumValues: ['events', 'fingerprints'],
        name: 'mode',
        required: true,
        type: 'enum',
      },
      {
        description: 'Exact assistant run id',
        maxLength: 256,
        minLength: 1,
        name: 'runId',
        required: false,
        type: 'string',
      },
      {
        description: 'Exact severity',
        enumValues: ['warn', 'error', 'fatal'],
        name: 'severity',
        required: false,
        type: 'enum',
      },
      {
        description: 'Inclusive ISO-8601 lower time bound',
        name: 'since',
        required: false,
        type: 'string',
      },
      {
        description: 'Exact assistant thread id',
        maxLength: 256,
        minLength: 1,
        name: 'threadId',
        required: false,
        type: 'string',
      },
      {
        description: 'Inclusive ISO-8601 upper time bound',
        name: 'until',
        required: false,
        type: 'string',
      },
    ],
    returns:
      'Bounded newest diagnostic rows or recurring fingerprint groups with explicit cap/output truncation metadata',
    toolId: 'brainstrike.queryDiagnostics',
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
        description: 'Maximum chunks to pack into the result, independent of the candidate limit',
        max: 100,
        min: 1,
        name: 'maxChunks',
        required: false,
        type: 'number',
      },
      {
        description: 'Optional selection snapshot id to retrieve against a pinned selection',
        minLength: 1,
        name: 'selectionSnapshotId',
        required: false,
        type: 'string',
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

  'brainstrike.querySelf': {
    description:
      "Run one read-only SQL SELECT against Brainstrike's own local PostgreSQL database — assistant run history, edit checkpoints, usage and cost, queue metrics, and the workspace code index — inside a sandbox that permits nothing but reads.",
    parameters: [
      {
        description:
          "What to do: 'listTables' lists readable tables, 'describeTable' lists one table's columns, 'query' runs sql, 'explain' returns sql's query plan, 'listLenses' lists saved lenses (.brainstrike/lenses/*.sql), 'lens' runs one by id. Fields the chosen mode does not use are ignored",
        enumValues: ['query', 'listTables', 'describeTable', 'explain', 'listLenses', 'lens'],
        name: 'mode',
        required: true,
        type: 'enum',
      },
      {
        description: 'Lens id. Required for mode=lens',
        maxLength: 64,
        name: 'lens',
        required: false,
        type: 'string',
      },
      {
        arrayItemType: 'string',
        description: 'mode=lens: one string per declared lens param, in order',
        name: 'values',
        required: false,
        type: 'array',
      },
      {
        description: 'A single SQL SELECT. Required for mode=query and mode=explain',
        maxLength: 4000,
        name: 'sql',
        required: false,
        type: 'string',
      },
      {
        description: 'Table name. Required for mode=describeTable',
        maxLength: 128,
        name: 'table',
        required: false,
        type: 'string',
      },
      {
        default: 50,
        description: 'Maximum rows for mode=query; the result flags truncation when more exist',
        max: 200,
        min: 1,
        name: 'maxRows',
        required: false,
        type: 'number',
      },
      {
        default: false,
        description: 'mode=explain only: execute the statement to collect real timings',
        name: 'analyze',
        required: false,
        type: 'boolean',
      },
    ],
    returns:
      'Column names once plus rows as positional arrays, with the row count, a truncation flag, and the planner cost estimate. Schema modes return table or column listings; explain returns the query plan',
    toolId: 'brainstrike.querySelf',
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
