export const TOOL_DESCRIPTIONS: Record<string, string> = {
  'brainstrike.askUser':
    'Ask the user a clarifying question and WAIT for their answer (the run pauses). Provide options for a structured choice (selectionMode multi_select allows several), or omit options for a free-text question',
  'brainstrike.deleteWorkspaceFile':
    'Permanently delete a single file in the selected workspace root and invalidate its index rows. DESTRUCTIVE and NOT recoverable through the tool; refuses directories (use executeCommand) and acts on a symlink itself (removes the link, never its target). Workspace-scoped; requires approval',
  'brainstrike.executeCommand':
    "Run an arbitrary shell command (tests, builds, linters, git, package managers). ARBITRARY EXECUTION with NO sandbox: the command can read or change anything the user can. By default the call suspends for the user's per-call approval before running; the user can let it run unprompted or deny it. Starts in the workspace root; the whole process tree is killed on timeout. Returns exitCode, a budget-bounded stdout/stderr tail, and durationMs",
  'brainstrike.findWorkspaceSymbol':
    "Locate a symbol's best-effort enclosing line range in a workspace file without returning whole-file content",
  'brainstrike.globWorkspace':
    'Enumerate workspace files whose path matches a glob (e.g. **/*.test.ts, src/**/*.tsx). Excludes .git/node_modules/build output by default; read-only',
  'brainstrike.grepSearch':
    "Grep indexed file content for an exact string or regex. Default 'files' mode surveys matching paths cheaply; 'content' mode (scoped with filePaths) returns path:line matches with context",
  'brainstrike.hybridSearch':
    'Hybrid workspace search fusing semantic (vector) and exact-term (BM25 keyword) rankings with reciprocal rank fusion; best default for code/doc retrieval mixing concepts with distinctive terms. Omit embeddingSetId to use the Workspace Index; fails visibly (never degrades) if the keyword index is unavailable',
  'brainstrike.listEmbeddingSpaces':
    'List available embedding spaces, workspace-index status, and optional coverage statistics',
  'brainstrike.listWorkspaceContext':
    'Inspect the current workspace root, selected context paths, and workspace index hint without reading file contents; compact summary by default, detail: true for per-file Tapestry ranges',
  'brainstrike.manageTaskList':
    'Record and update a structured plan for the current thread as a task list (whole-list replace). Each task has content (imperative label), activeForm (present-tense in-progress label), and status pending/in_progress/completed. Keep exactly one task in_progress; mark tasks completed as you finish them. The list is re-shown to you every turn and rendered to the user as a progress checklist',
  'brainstrike.queryEmbeddingSpace':
    'Query semantic workspace context; omit embeddingSetId to use the Workspace Index by default',
  'brainstrike.readWorkspaceContext':
    'Read selected or explicit workspace files under strict file and token budgets after semantic search needs exact source',
  'brainstrike.readWorkspaceDirectory':
    'List a workspace directory in a compact, token-efficient format',
  'brainstrike.readWorkspaceFile':
    'Read a file from the selected workspace root with optional range and truncation',
  'brainstrike.renameWorkspaceFile':
    'Rename or move a single file within the selected workspace root, creating missing destination parents and invalidating the source index rows. Refuses overwriting an existing destination and refuses directories; refuses if the source changed on disk since you last read it — re-read and retry; acts on a symlink itself (moves the link, never its target). Workspace-scoped; requires approval',
  'brainstrike.stringReplaceWorkspaceFile':
    'Surgically edit a workspace file by replacing one oldStr block with newStr (fuzzy-matched; refuses ambiguous matches; refuses if the file changed on disk since you last read it — re-read and retry; workspace-scoped, requires approval)',
  'brainstrike.submitPlan':
    'Submit a structured implementation plan (title, overview, ordered steps, optional risks/verification) for the user to Approve or Reject. The run PAUSES until they respond; rejection feedback is returned so you can revise and resubmit',
  'brainstrike.updateWorkspaceContextSelection':
    'Bulk add, remove, or replace files selected in the workspace context explorer for reusable curated context',
  'brainstrike.updateWorkspaceTapestrySelections':
    'Create, update, or clear token-aware Tapestry line ranges for selected workspace context files',
  'brainstrike.webExtract':
    'Fetch the readable content of up to 5 public web pages as markdown (the natural follow-up to webSearch results, or for a user-pasted URL). SENDS THE URLS TO AN EXTERNAL EXTRACTION SERVICE (Tavily); refuses non-http(s), credentialed, and private/internal URLs before anything is sent. Returns a clear "unavailable" message (not an error) when no Tavily key is configured',
  'brainstrike.webSearch':
    'Search the web for current docs, APIs, error messages, and library usage. SENDS YOUR QUERY TO AN EXTERNAL WEB-SEARCH SERVICE (the model provider\'s built-in search when available, otherwise Tavily). Returns a clear "unavailable" message (not an error) when no provider-native search and no Tavily key are configured',
  'brainstrike.writeWorkspaceFile':
    'Write or create a UTF-8 file in the selected workspace root (overwrites existing content; refuses if the file changed on disk since you last read it — re-read and retry; workspace-scoped, requires approval)',
  skill:
    "Activate an Agent Skill by name: loads the skill's full SKILL.md instructions into the conversation, plus a listing of its bundled references/scripts/assets. Read-only; activate proactively when a task matches a skill's description",
  // biome-ignore lint/style/useNamingConvention: Mastra's canonical skill tool id.
  skill_read:
    'Read a bundled file from an activated skill directory (references/, scripts/, or assets/), optionally sliced by startLine/endLine. Read-only and containment-checked to the skill directory',
  // biome-ignore lint/style/useNamingConvention: Mastra's canonical skill tool id.
  skill_search:
    'Search across installed skill instructions and reference files by keyword; returns matching skills, sources, and line-scoped snippets. Read-only',
};
