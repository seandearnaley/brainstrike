import { formatTokenCount } from '@brainstrike/utils/token-counting-heuristics';

export function buildContextBudgetNote(budgetTokens: number | undefined): string | null {
  if (budgetTokens === undefined || !Number.isFinite(budgetTokens) || budgetTokens <= 0) {
    return null;
  }
  return `Context budget: about ${formatTokenCount(budgetTokens)} of input context are available this run. Suggest starting a new thread if context runs low.`;
}

const HARNESS_FRAMING =
  'You run inside the Brainstrike IDE. The user is interactively curating context in a visual Context Explorer alongside this chat; the selections you make with the context tools appear in that UI and become the context the user feeds to an LLM. Be precise: prefer selecting the specific lines that matter over whole files.';

const BRAINSTRIKE_CONTEXT_TOOL_IDS = {
  executeCommand: 'brainstrike.executeCommand',
  findWorkspaceSymbol: 'brainstrike.findWorkspaceSymbol',
  globWorkspace: 'brainstrike.globWorkspace',
  grepSearch: 'brainstrike.grepSearch',
  listEmbeddingSpaces: 'brainstrike.listEmbeddingSpaces',
  listWorkspaceContext: 'brainstrike.listWorkspaceContext',
  queryEmbeddingSpace: 'brainstrike.queryEmbeddingSpace',
  readWorkspaceContext: 'brainstrike.readWorkspaceContext',
  readWorkspaceFile: 'brainstrike.readWorkspaceFile',
  stringReplaceWorkspaceFile: 'brainstrike.stringReplaceWorkspaceFile',
  updateWorkspaceContextSelection: 'brainstrike.updateWorkspaceContextSelection',
  updateWorkspaceTapestrySelections: 'brainstrike.updateWorkspaceTapestrySelections',
  webSearch: 'brainstrike.webSearch',
  writeWorkspaceFile: 'brainstrike.writeWorkspaceFile',
} as const;

interface ModelFacingToolNames {
  executeCommand: string | null;
  findWorkspaceSymbol: string | null;
  globWorkspace: string | null;
  grepSearch: string | null;
  listEmbeddingSpaces: string | null;
  listWorkspaceContext: string | null;
  queryEmbeddingSpace: string | null;
  readWorkspaceContext: string | null;
  readWorkspaceFile: string | null;
  stringReplaceWorkspaceFile: string | null;
  updateWorkspaceContextSelection: string | null;
  updateWorkspaceTapestrySelections: string | null;
  webSearch: string | null;
  writeWorkspaceFile: string | null;
}

function buildOriginalToModelFacingToolNameMap(
  toolNameMap: ReadonlyMap<string, string>
): Map<string, string> {
  const originalToModelFacing = new Map<string, string>();
  for (const [modelFacingName, originalName] of toolNameMap.entries()) {
    originalToModelFacing.set(originalName, modelFacingName);
  }
  return originalToModelFacing;
}

function resolveModelFacingToolName(
  originalToModelFacingToolNameMap: ReadonlyMap<string, string>,
  originalToolId: string
): string | null {
  return originalToModelFacingToolNameMap.get(originalToolId) ?? null;
}

function getModelFacingToolNames(toolNameMap: ReadonlyMap<string, string>): ModelFacingToolNames {
  const originalToModelFacing = buildOriginalToModelFacingToolNameMap(toolNameMap);
  return {
    executeCommand: resolveModelFacingToolName(
      originalToModelFacing,
      BRAINSTRIKE_CONTEXT_TOOL_IDS.executeCommand
    ),
    findWorkspaceSymbol: resolveModelFacingToolName(
      originalToModelFacing,
      BRAINSTRIKE_CONTEXT_TOOL_IDS.findWorkspaceSymbol
    ),
    globWorkspace: resolveModelFacingToolName(
      originalToModelFacing,
      BRAINSTRIKE_CONTEXT_TOOL_IDS.globWorkspace
    ),
    grepSearch: resolveModelFacingToolName(
      originalToModelFacing,
      BRAINSTRIKE_CONTEXT_TOOL_IDS.grepSearch
    ),
    listEmbeddingSpaces: resolveModelFacingToolName(
      originalToModelFacing,
      BRAINSTRIKE_CONTEXT_TOOL_IDS.listEmbeddingSpaces
    ),
    listWorkspaceContext: resolveModelFacingToolName(
      originalToModelFacing,
      BRAINSTRIKE_CONTEXT_TOOL_IDS.listWorkspaceContext
    ),
    queryEmbeddingSpace: resolveModelFacingToolName(
      originalToModelFacing,
      BRAINSTRIKE_CONTEXT_TOOL_IDS.queryEmbeddingSpace
    ),
    readWorkspaceContext: resolveModelFacingToolName(
      originalToModelFacing,
      BRAINSTRIKE_CONTEXT_TOOL_IDS.readWorkspaceContext
    ),
    readWorkspaceFile: resolveModelFacingToolName(
      originalToModelFacing,
      BRAINSTRIKE_CONTEXT_TOOL_IDS.readWorkspaceFile
    ),
    stringReplaceWorkspaceFile: resolveModelFacingToolName(
      originalToModelFacing,
      BRAINSTRIKE_CONTEXT_TOOL_IDS.stringReplaceWorkspaceFile
    ),
    updateWorkspaceContextSelection: resolveModelFacingToolName(
      originalToModelFacing,
      BRAINSTRIKE_CONTEXT_TOOL_IDS.updateWorkspaceContextSelection
    ),
    updateWorkspaceTapestrySelections: resolveModelFacingToolName(
      originalToModelFacing,
      BRAINSTRIKE_CONTEXT_TOOL_IDS.updateWorkspaceTapestrySelections
    ),
    webSearch: resolveModelFacingToolName(
      originalToModelFacing,
      BRAINSTRIKE_CONTEXT_TOOL_IDS.webSearch
    ),
    writeWorkspaceFile: resolveModelFacingToolName(
      originalToModelFacing,
      BRAINSTRIKE_CONTEXT_TOOL_IDS.writeWorkspaceFile
    ),
  };
}

function formatAvailableToolNames(names: ModelFacingToolNames): string {
  const available = Object.values(names).filter((name): name is string => Boolean(name));
  return available.length > 0 ? available.join(', ') : 'none';
}

/**
 * Compact instructions for the built-in LOCAL model (Gemma E2B on-device).
 *
 * The hosted default instructions below are a dense multi-thousand-token
 * playbook tuned for frontier models; on a 2B local model they bury the user
 * request, degrade tool selection, and inflate the WebGPU prefill (long local
 * prompts are also where ONNX-WebGPU kernel failures live). Keep this short
 * and directive.
 */
export function buildLocalDefaultInstructions(toolNameMap: ReadonlyMap<string, string>): string {
  const names = getModelFacingToolNames(toolNameMap);
  const searchLine =
    names.grepSearch && names.queryEmbeddingSpace
      ? `To look up project code: use ${names.grepSearch} for exact strings or identifiers, and ${names.queryEmbeddingSpace} for conceptual questions.`
      : '';
  const globLine = names.globWorkspace
    ? `To find files by name/path pattern (e.g. **/*.test.ts), use ${names.globWorkspace}.`
    : '';
  const readLine = names.readWorkspaceFile
    ? `Use ${names.readWorkspaceFile} to read a specific file when needed.`
    : '';
  const webSearchLine = names.webSearch
    ? `For public web info you do not know (library docs, errors), use ${names.webSearch} (it sends the query to an external service; needs a Tavily key).`
    : '';

  return [
    'You are the Brainstrike IDE assistant, running fully on this device.',
    'Answer the user directly and concisely.',
    'Project files are NOT preloaded; only use a tool when the answer needs project context you do not already have.',
    searchLine,
    globLine,
    readLine,
    webSearchLine,
    'If a tool fails, say so plainly. Only run state-changing tools after the user confirms.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Multi-root workflow guidance: the model learns the open folders (roots) from
 * listWorkspaceContext, then qualifies path-based read/search tools with a
 * `root` argument when several folders are open. Empty when listWorkspaceContext
 * or every root-qualified tool is absent.
 */
function buildMultiRootInstruction(names: ModelFacingToolNames): string {
  const rootQualifiedToolNames = [
    names.grepSearch,
    names.globWorkspace,
    names.queryEmbeddingSpace,
    names.readWorkspaceFile,
    names.readWorkspaceContext,
    names.findWorkspaceSymbol,
    names.writeWorkspaceFile,
    names.stringReplaceWorkspaceFile,
    names.executeCommand,
  ].filter((name): name is string => Boolean(name));
  if (!(names.listWorkspaceContext && rootQualifiedToolNames.length > 0)) {
    return '';
  }
  const writeBackTools = [
    names.updateWorkspaceContextSelection,
    names.updateWorkspaceTapestrySelections,
  ].filter((name): name is string => Boolean(name));
  const writeBackNote =
    writeBackTools.length > 0
      ? ` Selection write-back (${writeBackTools.join(', ')}) accepts the same "root" argument: pass it to curate a specific open folder (it need not be the focused one); omit it when only one folder is open.`
      : '';
  return `The workspace can have several folders ("roots") open at once: ${names.listWorkspaceContext} returns workspaceRoots — each open folder's name and id. File paths are relative to a root, so when more than one folder is open a bare path is ambiguous: pass a "root" argument (the folder name or id from workspaceRoots) to ${rootQualifiedToolNames.join(', ')} to say which folder you mean, and omit it when only one folder is open. Search and read results are labelled with their owning rootName/rootId — use that label to disambiguate and to choose the root for any follow-up call.${writeBackNote}`;
}

/**
 * Guidance for the mutation tools (writeWorkspaceFile + stringReplaceWorkspaceFile).
 * Each clause is emitted only when its tool is registered, so an unavailable verb
 * is never advertised.
 */
function buildWriteInstruction(names: ModelFacingToolNames): string {
  const clauses: string[] = [];
  if (names.writeWorkspaceFile) {
    clauses.push(
      `To create a new file or fully rewrite one, use ${names.writeWorkspaceFile}: it writes the full UTF-8 content to a workspace-relative path, OVERWRITING any existing file and creating missing parent directories.`
    );
  }
  if (names.stringReplaceWorkspaceFile) {
    const preferClause = names.writeWorkspaceFile
      ? ` Prefer ${names.stringReplaceWorkspaceFile} over ${names.writeWorkspaceFile} when changing part of an existing file.`
      : '';
    clauses.push(
      `To make a surgical edit to an existing file, use ${names.stringReplaceWorkspaceFile}: read the file first, then pass an oldStr block of WHOLE LINES with enough surrounding context to identify exactly ONE location, plus the newStr to replace it with (empty newStr deletes the block). A block that matches more than once is REFUSED (add context and retry), and a short fragment can match inside a larger token (e.g. "bar" inside "foobarbaz"), so prefer complete lines over substrings. It also REFUSES not-found matches instead of guessing, so re-read and adjust oldStr if it reports one.${preferClause}`
    );
  }
  if (clauses.length === 0) {
    return '';
  }
  clauses.push(
    'These edit tools are workspace-scoped (the path can never leave the open folder) and edit-risk, so only call them after the user confirms the change.'
  );
  return clauses.join(' ');
}

/**
 * Guidance for the file-search tools (grepSearch for content + globWorkspace for
 * name/path shape). Each clause is emitted only when its tool is registered, so
 * an unavailable verb is never advertised; combined here to keep the assembler's
 * complexity low.
 */
function buildSearchInstruction(names: ModelFacingToolNames): string {
  const grepClause = names.grepSearch
    ? `For exact strings, identifiers, and error messages, call ${names.grepSearch} FIRST — it greps file content across BOTH the index AND the live on-disk files, so a file you just edited is matched fresh even before re-indexing (each match is labelled source: index/live/both — re-grep after an edit to confirm your change landed). Its default 'files' outputMode cheaply surveys WHICH files match; follow up with outputMode 'content' scoped via filePaths to see the matching lines. Prefer several narrow searches over one broad one. Prefer it over semantic search whenever you know the exact wording.`
    : 'Exact-text grep search is unavailable in this run.';
  const globClause = names.globWorkspace
    ? `To find files by NAME or PATH shape (e.g. every test file, all package.json, a component's tsx), call ${names.globWorkspace} with a glob like **/*.test.ts or src/**/*.tsx — use this instead of ${names.grepSearch ?? 'content search'} (which searches file CONTENT) and instead of paging readWorkspaceDirectory (which lists ONE level). It skips .git/node_modules/build output by default.`
    : '';
  return [grepClause, globClause].filter(Boolean).join(' ');
}

/**
 * Guidance for the shell execution tool. Emitted only when the tool is
 * available (the permission policy did not deny it), so an unavailable verb is
 * never advertised. The wording is honest: there is NO sandbox, and by default
 * (execute resolves to 'ask') the call suspends for the user's per-call approval
 * before the command runs.
 */
function buildExecuteCommandInstruction(names: ModelFacingToolNames): string {
  if (!names.executeCommand) {
    return '';
  }
  return `To run a command — tests, builds, linters, git status/diff, package managers — use ${names.executeCommand}. It runs an ARBITRARY shell command on the user's machine with NO sandbox: it can read or change anything the user can. By default the call SUSPENDS for the user's per-call approval before the command runs (they approve to run it or decline to skip it); the user may instead let it run unprompted or deny it entirely. The command starts in the workspace root; the whole process tree is killed on timeout and its output is bounded (pipe through "| tail -n N" for long logs). Prefer non-destructive, read-only commands; NEVER run destructive ones (rm -rf, git push --force, git reset --hard) unless the user explicitly asked for that exact action.`;
}

/**
 * Guidance for the web-search tool. Emitted only when the tool is registered.
 * Honest about the external-service privacy caveat and about when to web-search
 * vs grep/read THIS project's code.
 */
function buildWebSearchInstruction(names: ModelFacingToolNames): string {
  if (!names.webSearch) {
    return '';
  }
  const localSearchAlternatives = [names.grepSearch, names.queryEmbeddingSpace].filter(
    (name): name is string => Boolean(name)
  );
  const alternativesClause =
    localSearchAlternatives.length > 0
      ? ` Do NOT use ${names.webSearch} for THIS project's own code or files — use ${localSearchAlternatives.join(' / ')} for that.`
      : '';
  return `To look up CURRENT public information you do not already know — library/framework docs, external APIs, error messages, recent releases — use ${names.webSearch}. It SENDS YOUR QUERY TO AN EXTERNAL SERVICE (Tavily), so never include secrets or private workspace contents in the query.${alternativesClause} It needs a Tavily API key in Settings: when none is configured it returns a non-fatal "unavailable" result (available: false) — relay that to the user rather than retrying. On a search error it returns a non-fatal error result; report it and continue.`;
}

export function buildDefaultInstructions(toolNameMap: ReadonlyMap<string, string>): string {
  const names = getModelFacingToolNames(toolNameMap);
  const workspaceInspectionInstruction = names.listWorkspaceContext
    ? `First inspect available selected context, token budgets, project-tree token counts, and the workspace index hint with ${names.listWorkspaceContext}; pass detail: true only when you need per-file Tapestry ranges.`
    : 'Workspace-selection inspection is unavailable in this run.';
  const multiRootInstruction = buildMultiRootInstruction(names);
  const searchInstruction = buildSearchInstruction(names);
  const semanticSearchInstruction =
    names.listEmbeddingSpaces && names.queryEmbeddingSpace
      ? `When you do NOT know the exact wording (concept or behavior questions), call ${names.queryEmbeddingSpace} without embeddingSetId so it uses the Workspace Index. Use ${names.listEmbeddingSpaces} first only when you need coverage details or a specific non-default embedding space.`
      : 'Semantic workspace search is unavailable unless both listEmbeddingSpaces and queryEmbeddingSpace are registered.';
  const readContextInstruction =
    names.readWorkspaceContext && names.readWorkspaceFile
      ? `Use ${names.readWorkspaceContext} or ${names.readWorkspaceFile} afterward when you need surrounding file contents beyond the retrieved source line ranges.`
      : names.readWorkspaceFile
        ? `Use ${names.readWorkspaceFile} afterward when you need surrounding file contents beyond retrieved source line ranges.`
        : 'Workspace file reading is unavailable in this run.';
  const writeInstruction = buildWriteInstruction(names);
  const executeCommandInstruction = buildExecuteCommandInstruction(names);
  const webSearchInstruction = buildWebSearchInstruction(names);
  const curationInstruction =
    names.queryEmbeddingSpace &&
    names.updateWorkspaceContextSelection &&
    names.updateWorkspaceTapestrySelections
      ? `When the user asks you to curate ideal reusable context, use ${names.queryEmbeddingSpace} to find candidate files and semantic chunks with persisted source line ranges, then call ${names.updateWorkspaceContextSelection} to bulk select files and ${names.updateWorkspaceTapestrySelections} to keep only relevant line ranges. Read files when surrounding lines are needed to refine the ranges. Keep the curation token-aware and prefer Tapestry ranges over whole files when a whole file would waste context.`
      : 'Reusable context curation is unavailable unless semantic search, workspace selection, and Tapestry selection tools are all registered.';

  const selectionDefaultInstruction =
    names.updateWorkspaceTapestrySelections && names.updateWorkspaceContextSelection
      ? `When the user asks you to select, add, or curate context, default to precise Tapestry line ranges with ${names.updateWorkspaceTapestrySelections}: select only the lines that matter, never the whole file. If the user names a specific symbol, function, type, section, or line range, you MUST select only that symbol's exact line span via ${names.updateWorkspaceTapestrySelections} and MUST NOT fall back to whole-file selection. Only use ${names.updateWorkspaceContextSelection} for whole-file selection when the user explicitly asks for the entire file or the whole file is genuinely needed. The line range you report to the user MUST exactly equal the ranges you passed to ${names.updateWorkspaceTapestrySelections} — never state a range you did not actually select.`
      : 'Precise context selection is unavailable unless the workspace selection and Tapestry selection tools are registered.';
  const tapestryMechanicsInstruction = names.updateWorkspaceTapestrySelections
    ? [
        `Tapestry ranges are 1-based and inclusive; pass them as ranges: [{ startLine, endLine }] to ${names.updateWorkspaceTapestrySelections}.`,
        names.queryEmbeddingSpace
          ? `${names.queryEmbeddingSpace} results include per-chunk 1-based source line ranges — pass those directly.`
          : '',
        names.readWorkspaceFile
          ? `When there is no embedding result for the target, ${names.readWorkspaceFile} returns the file content plus 1-based startLine/endLine/totalLines metadata (the content itself has no inline line numbers): read it and count from startLine to find the first and last line of the requested symbol, then pass those as the range.`
          : '',
      ]
        .filter(Boolean)
        .join(' ')
    : '';
  const symbolLookupInstruction =
    names.findWorkspaceSymbol && names.updateWorkspaceTapestrySelections
      ? `When the user names a symbol/function/type, call ${names.findWorkspaceSymbol} to get its best-effort range without reading the whole file, verify the returned range covers the symbol, then pass it to ${names.updateWorkspaceTapestrySelections}.`
      : '';
  const colorGroupingInstruction = names.updateWorkspaceTapestrySelections
    ? 'You may set a named color per range (red, orange, yellow, green, cyan, blue, purple, pink, gray) to group related context — reuse the same color for the same concept.'
    : '';
  const selectionLine = [
    selectionDefaultInstruction,
    tapestryMechanicsInstruction,
    symbolLookupInstruction,
    colorGroupingInstruction,
  ]
    .filter(Boolean)
    .join(' ');

  return `You are a helpful assistant for the Brainstrike IDE.
${HARNESS_FRAMING}
Use tools when they help you answer accurately.
Project files, context explorer selections, file trees, token estimates, and embedding spaces are not preloaded into your prompt.
Registered Brainstrike native context tools in this run: ${formatAvailableToolNames(names)}.
When project or codebase context is needed, use registered Brainstrike native tools explicitly. ${workspaceInspectionInstruction} ${searchInstruction} ${semanticSearchInstruction} ${readContextInstruction} ${writeInstruction} ${executeCommandInstruction} ${webSearchInstruction}
${multiRootInstruction}
${curationInstruction}
${selectionLine}
Do not assume selected files or embedding spaces are already included. Keep file and retrieval budgets small, and report skipped or truncated tool results when they affect the answer.
Tool results are bounded: when a result has truncated: true, it is a valid partial result — use its hint (offset, filePaths, smaller limits, deeper paths) to fetch exactly what is missing instead of repeating or broadening the same call.
Independent read-only lookups (searches, directory listings, file reads with no dependency between them) execute in parallel — issue them together in one step instead of one per turn.
If an expected Brainstrike native tool is unavailable, say exactly which tool ID is missing and continue with another available tool only when that still answers the user.
If the user asks what tools you have available, list the tool IDs you can call in this session and briefly describe each one.
Only run state-changing tools after the user confirms.
Provide concise answers after using tools.`;
}
