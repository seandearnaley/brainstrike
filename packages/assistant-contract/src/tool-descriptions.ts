import { isNativeToolId, NATIVE_TOOL_ID, type NativeToolId } from './native-tool-catalog.js';

export const TOOL_DESCRIPTIONS = {
  [NATIVE_TOOL_ID.askUser]:
    'Ask the user a clarifying question and WAIT for their answer (the run pauses). Provide options for a structured choice (selectionMode multi_select allows several), or omit options for a free-text question',
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
  [NATIVE_TOOL_ID.listEmbeddingSpaces]:
    'List available embedding spaces, workspace-index status, and optional coverage statistics',
  [NATIVE_TOOL_ID.listWorkspaceContext]:
    'Inspect open workspace roots, the Main operating-root path, Focused-root selected context, and workspace index hint without reading file contents; compact summary by default, detail: true for per-file Tapestry ranges',
  [NATIVE_TOOL_ID.lspInspect]:
    "Semantic code inspection at a cursor via a language server (TypeScript/JavaScript): the inferred TYPE (hover), line diagnostics, the symbol's DEFINITION location, and its IMPLEMENTATIONS. Give the file path, the 1-based line, and a `match` string that is that line's text (or a fragment occurring exactly once on it) with a `<<<` marker inserted right before the symbol (exactly one `<<<`); refuses with the actual line text if the match is not found on that line. Read-only; returns a clear 'unavailable' note (not an error) for unsupported file types or when no server is available",
  [NATIVE_TOOL_ID.manageTaskList]:
    'Record and update a structured plan for the current thread as a task list (whole-list replace). Each task has content (imperative label), activeForm (present-tense in-progress label), and status pending/in_progress/completed. Keep exactly one task in_progress; mark tasks completed as you finish them. The list is re-shown to you every turn and rendered to the user as a progress checklist',
  [NATIVE_TOOL_ID.queryEmbeddingSpace]:
    'Query semantic workspace context; omit embeddingSetId to use the Workspace Index by default',
  [NATIVE_TOOL_ID.readToolOutputArtifact]:
    'Read the next bounded page of a durable oversized tool result using the exact opaque cursor from the prior result. Copy the cursor byte-for-byte; never decode, pad, edit, or recreate it. The artifact is restricted to the current thread; malformed, changed, expired, or unavailable cursors fail visibly',
  [NATIVE_TOOL_ID.readWorkspaceContext]:
    'Read selected or explicit workspace files under strict file and token budgets after semantic search needs exact source',
  [NATIVE_TOOL_ID.readWorkspaceDirectory]:
    'List a workspace directory in a compact, token-efficient format',
  [NATIVE_TOOL_ID.readWorkspaceFile]:
    'Read a file from a chosen open workspace root as bounded, line-numbered pages with an exact continuation cursor. For later pages pass path + cursor (and optional maxChars); omit root/startLine/endLine',
  [NATIVE_TOOL_ID.renameWorkspaceFile]:
    'Rename or move a single file within a chosen open workspace root, creating missing destination parents and invalidating the source index rows. Refuses overwriting an existing destination and refuses directories; refuses if the source changed on disk since you last read it — re-read and retry; acts on a symlink itself (moves the link, never its target). Workspace-scoped; requires approval',
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
