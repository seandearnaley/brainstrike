import { isNativeToolId, NATIVE_TOOL_ID, type NativeToolId } from './native-tool-catalog.js';

/**
 * Worked example queries embedded in the `querySelf` description.
 *
 * Exported as a constant rather than prose so a test can EXECUTE them against a
 * migrated database (`packages/db/__tests__/agent-sql-service.test.ts`). A
 * broken example is worse than none — it teaches the model a column that does
 * not exist and costs it a turn — and this makes drift a build failure the day a
 * migration renames something, instead of a silent regression.
 *
 * Keep them short: this text is paid for on every request that loads the tool.
 */
export const QUERY_SELF_EXAMPLE_QUERIES: readonly string[] = [
  'SELECT path, count(*) AS reverts FROM brainstrike_assistant_edit_checkpoints WHERE reverted_at IS NOT NULL GROUP BY path ORDER BY reverts DESC',
];

export const TOOL_DESCRIPTIONS = {
  [NATIVE_TOOL_ID.askUser]:
    'Ask the user a clarifying question and WAIT for their answer (the run pauses). Provide options for a structured choice (selectionMode multi_select allows several), or omit options for a free-text question',
  [NATIVE_TOOL_ID.browserGetPageText]:
    "Read the visible text of the browser pane's current page (active tab), truncated to maxChars",
  [NATIVE_TOOL_ID.browserNavigate]:
    "Open a URL in the app's embedded browser pane (creates a tab when none is open) and wait for the load. Bare hosts get https://; non-URL text becomes a web search. Returns the final url and title",
  [NATIVE_TOOL_ID.browserReadPage]:
    "Read the browser pane's current page as a compact accessibility tree. Interactive elements carry [ref=eN] handles for later actions; filter 'interactive' returns only actionable elements",
  [NATIVE_TOOL_ID.deleteWorkspaceFile]:
    'Permanently delete a single file in a chosen open workspace root and invalidate its index rows. DESTRUCTIVE and NOT recoverable through the tool; refuses directories (use executeCommand) and acts on a symlink itself (removes the link, never its target). Workspace-scoped; requires approval',
  [NATIVE_TOOL_ID.executeCommand]:
    'Run a shell command for tests, builds, git, and other tools. NO sandbox: it can read or change anything the user can. Never run destructive commands unless explicitly requested. Requires per-call approval by default. Starts in a chosen open root; kills the process tree on timeout. Returns exitCode, bounded stdout/stderr tail, and durationMs',
  [NATIVE_TOOL_ID.findWorkspaceSymbol]:
    "Locate a symbol's best-effort enclosing line range in a workspace file without returning whole-file content",
  [NATIVE_TOOL_ID.globWorkspace]:
    'Enumerate workspace files whose path matches a glob (e.g. **/*.test.ts, src/**/*.tsx). Excludes .git/node_modules/build output by default; read-only',
  [NATIVE_TOOL_ID.grepSearch]:
    "Grep indexed and live on-disk file content for an exact string or regex. Default 'files' mode surveys matching paths cheaply; 'content' mode (scoped with filePaths) returns path:line matches with context",
  [NATIVE_TOOL_ID.hybridSearch]:
    'Hybrid workspace search fusing semantic (vector) and exact-term (BM25 keyword) rankings with reciprocal rank fusion; best default for code/doc retrieval mixing concepts with distinctive terms. Omit embeddingSetId to use the Workspace Index; fails visibly (never degrades) if the keyword index is unavailable',
  [NATIVE_TOOL_ID.inspectCommandSessions]:
    'List persistent command sessions in one open workspace root, or read bounded incremental PTY output. Continue a truncated list with offset and output with nextCursor; use read cursor -1 to attach at the live tail without replay. Read-only and workspace-scoped; command text, stdin, cwd, and PTY output are redacted from durable history',
  [NATIVE_TOOL_ID.listEmbeddingSpaces]:
    'List available embedding spaces, workspace-index status, and optional coverage statistics',
  [NATIVE_TOOL_ID.listWorkspaceContext]:
    'Inspect open workspace roots, the Main operating-root path, Focused-root selected context, and workspace index hint without reading file contents; compact summary by default, detail: true for per-file Tapestry ranges',
  [NATIVE_TOOL_ID.lspInspect]:
    "LSP (Language Server Protocol) semantic code inspection for TypeScript/JavaScript: the inferred TYPE (hover), line diagnostics, the symbol's DEFINITION location, and its IMPLEMENTATIONS. Give the file path, 1-based line, and `match`: prefer the unique identifier itself (for example `computeTotal`); when it repeats on that line, pass a unique line fragment with exactly one `<<<` immediately before the intended occurrence. Wrong-line identifiers return bounded candidate lines for an explicit retry; ambiguous targets never guess. Read-only; returns a clear 'unavailable' note (not an error) for unsupported file types or when no server is available",
  [NATIVE_TOOL_ID.manageCanvas]:
    'Create, list, or version-update a persisted HTML Canvas document for the current thread. update replaces oldString only when it occurs exactly once; rewrite replaces the whole HTML. Every change creates a new reversible version',
  [NATIVE_TOOL_ID.manageCommandSession]:
    'Start, write to, stop, or remove a persistent PTY command session in one open workspace root. Pass exactly one typed operation. Use this for servers and interactive commands that must outlive one tool call; use executeCommand for normal bounded commands. Arbitrary execution with no sandbox; requires approval by default',
  [NATIVE_TOOL_ID.manageTaskList]:
    'Record and update a structured plan for the current thread as a task list (whole-list replace). Each task has content (imperative label), activeForm (present-tense in-progress label), and status pending/in_progress/completed. Keep exactly one task in_progress; mark tasks completed as you finish them. The list is re-shown to you every turn and rendered to the user as a progress checklist',
  [NATIVE_TOOL_ID.queryEmbeddingSpace]:
    'Query semantic workspace context; omit embeddingSetId to use the Workspace Index by default',
  [NATIVE_TOOL_ID.queryDiagnostics]:
    'Query Brainstrike durable diagnostic events without re-running the app. Use mode=events for newest matching rows or mode=fingerprints to group recurring failures. Filters are exact severity/fingerprint/run/thread plus an inclusive ISO time window; results are hard-capped and output-budget truncation is explicit. Read-only',
  [NATIVE_TOOL_ID.querySelf]: `Run ONE read-only SQL SELECT over Brainstrike's own local Postgres: this assistant's history (run outcomes, edit checkpoints, usage/cost, queue metrics) plus the code index (file_records, file_chunks) and symbol graph (file_symbols, file_symbol_refs joined by name). Best for aggregates, trends, and call-graph traversal; search arms join a traversal in the same statement (BM25: content <@> to_bm25query('terms','idx_file_chunks_content_bm25') ASC; vector: embedding <=> a stored embedding). ALWAYS set mode: listTables first, then describeTable with table, then query or explain with sql; unused fields ignored. Saved lenses (.brainstrike/lenses/*.sql): mode listLenses, then mode lens with lens + values. Example sql: ${QUERY_SELF_EXAMPLE_QUERIES[0]}. Costly plans are refused with the estimate — narrow and retry. Catalog/stats views readable (pg_indexes, pg_stats, pg_settings, pg_stat_user_*), but pg_stat_* counters read 0 until you run SELECT pg_stat_force_next_flush()`,
  [NATIVE_TOOL_ID.readToolOutputArtifact]:
    'Read the next bounded page of a durable oversized tool result using the exact opaque cursor from the prior result. Copy the cursor byte-for-byte; never decode, pad, edit, or recreate it. The artifact is restricted to the current thread; malformed, changed, expired, or unavailable cursors fail visibly',
  [NATIVE_TOOL_ID.readWorkspaceContext]:
    'Read selected or explicit workspace files under strict file and token budgets after semantic search needs exact source',
  [NATIVE_TOOL_ID.readWorkspaceDirectory]:
    'List a workspace directory in a compact, token-efficient format',
  [NATIVE_TOOL_ID.readWorkspaceFile]:
    'Read a file from a chosen open workspace root as bounded, line-numbered pages with a short thread-scoped continuation handle. For later pages pass only cursor (and optional maxChars); omit path/root/startLine/endLine',
  [NATIVE_TOOL_ID.renameWorkspaceFile]:
    'Rename or move a single file within a chosen open workspace root, creating missing destination parents and invalidating the source index rows. Refuses overwriting an existing destination and refuses directories; refuses if the source changed on disk since you last read it — re-read and retry; acts on a symlink itself (moves the link, never its target). Workspace-scoped; requires approval',
  [NATIVE_TOOL_ID.runPython]:
    'Run Python in an OS sandbox for computation, parsing, and data wrangling. Network only to allowedDomains you name, each run needing explicit per-call user approval (omit for none); writes only to a scratch dir deleted afterwards; reads unrestricted. print() to return values. Requires approval',
  [NATIVE_TOOL_ID.runSkillScript]:
    "Run an enabled Agent Skill's listed script with literal argv in a mounted root/cwd. Resolution and approval required",
  [NATIVE_TOOL_ID.stringReplaceWorkspaceFile]:
    'Surgically edit a file in a chosen open workspace root by replacing one oldStr block with newStr (fuzzy-matched; refuses ambiguous matches; refuses if the file changed on disk since you last read it — re-read and retry; workspace-scoped, requires approval)',
  [NATIVE_TOOL_ID.submitPlan]:
    'Submit a structured implementation plan (title, overview, ordered steps, optional risks/verification) for the user to Approve or Reject. The run PAUSES until they respond; rejection feedback is returned so you can revise and resubmit',
  [NATIVE_TOOL_ID.updateWorkspaceContextSelection]:
    'Bulk add, remove, or replace files selected in the workspace context explorer for reusable curated context',
  [NATIVE_TOOL_ID.updateWorkspaceTapestrySelections]:
    'Create, update, or clear token-aware Tapestry line ranges for selected workspace context files',
  [NATIVE_TOOL_ID.webExtract]:
    'Fetch the readable content of up to 5 public web pages as markdown (the natural follow-up to webSearch results, or for a user-pasted URL). SENDS THE URLS TO AN EXTERNAL EXTRACTION SERVICE (Tavily); refuses non-http(s), credentialed, and private/internal URLs before anything is sent. Preserves complete source content; larger results provide an exact brainstrike.readToolOutputArtifact continuation cursor. Returns a clear "unavailable" message (not an error) when no Tavily key is configured',
  [NATIVE_TOOL_ID.webSearch]:
    'Search the web for current docs, APIs, error messages, and library usage. SENDS YOUR QUERY TO AN EXTERNAL WEB-SEARCH SERVICE (the model provider\'s built-in search when available, otherwise Tavily). Returns a clear "unavailable" message (not an error) when no provider-native search and no Tavily key are configured',
  [NATIVE_TOOL_ID.writeWorkspaceFile]:
    'Write or create a UTF-8 file in a chosen open workspace root (overwrites existing content; refuses if the file changed on disk since you last read it — re-read and retry; workspace-scoped, requires approval)',
  [NATIVE_TOOL_ID.skill]:
    "Activate an Agent Skill by name: loads the skill's full SKILL.md instructions into the conversation, plus a listing of its bundled references/scripts/assets. Read-only; activate proactively when a task matches a skill's description",
  [NATIVE_TOOL_ID.skillRead]:
    'Read a bundled file from an activated skill directory (references/, scripts/, or assets/), optionally sliced by startLine/endLine. Read-only and containment-checked to the skill directory',
  [NATIVE_TOOL_ID.skillSearch]:
    'Search across installed skill instructions and reference files by keyword; returns matching skills, sources, and line-scoped snippets. Read-only',
} satisfies Record<NativeToolId, string>;

export function getNativeToolDescription(toolId: string): string | undefined {
  return isNativeToolId(toolId) ? TOOL_DESCRIPTIONS[toolId] : undefined;
}
