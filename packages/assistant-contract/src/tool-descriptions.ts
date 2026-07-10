export const TOOL_DESCRIPTIONS: Record<string, string> = {
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
    'Rename or move a single file within the selected workspace root, creating missing destination parents and invalidating the source index rows. Refuses overwriting an existing destination and refuses directories; acts on a symlink itself (moves the link, never its target). Workspace-scoped; requires approval',
  'brainstrike.stringReplaceWorkspaceFile':
    'Surgically edit a workspace file by replacing one oldStr block with newStr (fuzzy-matched; refuses ambiguous matches; workspace-scoped, requires approval)',
  'brainstrike.updateWorkspaceContextSelection':
    'Bulk add, remove, or replace files selected in the workspace context explorer for reusable curated context',
  'brainstrike.updateWorkspaceTapestrySelections':
    'Create, update, or clear token-aware Tapestry line ranges for selected workspace context files',
  'brainstrike.webSearch':
    'Search the web via Tavily for current docs, APIs, error messages, and library usage. SENDS YOUR QUERY TO AN EXTERNAL SERVICE (Tavily). Requires a Tavily API key in Settings; returns a clear "unavailable" message (not an error) when no key is configured',
  'brainstrike.writeWorkspaceFile':
    'Write or create a UTF-8 file in the selected workspace root (overwrites existing content; workspace-scoped, requires approval)',
};
