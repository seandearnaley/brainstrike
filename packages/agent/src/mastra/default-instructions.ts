const HARNESS_FRAMING =
  'You run inside the Brainstrike IDE. The user is interactively curating context in a visual Context Explorer alongside this chat; the selections you make with the context tools appear in that UI and become the context the user feeds to an LLM. Be precise: prefer selecting the specific lines that matter over whole files.';

const BRAINSTRIKE_CONTEXT_TOOL_IDS = {
  listWorkspaceContext: 'brainstrike.listWorkspaceContext',
  readWorkspaceContext: 'brainstrike.readWorkspaceContext',
  readWorkspaceFile: 'brainstrike.readWorkspaceFile',
  listEmbeddingSpaces: 'brainstrike.listEmbeddingSpaces',
  queryEmbeddingSpace: 'brainstrike.queryEmbeddingSpace',
  updateWorkspaceContextSelection: 'brainstrike.updateWorkspaceContextSelection',
  updateWorkspaceTapestrySelections: 'brainstrike.updateWorkspaceTapestrySelections',
} as const;

interface ModelFacingToolNames {
  listEmbeddingSpaces: string | null;
  listWorkspaceContext: string | null;
  queryEmbeddingSpace: string | null;
  readWorkspaceContext: string | null;
  readWorkspaceFile: string | null;
  updateWorkspaceContextSelection: string | null;
  updateWorkspaceTapestrySelections: string | null;
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
    updateWorkspaceContextSelection: resolveModelFacingToolName(
      originalToModelFacing,
      BRAINSTRIKE_CONTEXT_TOOL_IDS.updateWorkspaceContextSelection
    ),
    updateWorkspaceTapestrySelections: resolveModelFacingToolName(
      originalToModelFacing,
      BRAINSTRIKE_CONTEXT_TOOL_IDS.updateWorkspaceTapestrySelections
    ),
  };
}

function formatAvailableToolNames(names: ModelFacingToolNames): string {
  const available = Object.values(names).filter((name): name is string => Boolean(name));
  return available.length > 0 ? available.join(', ') : 'none';
}

export function buildDefaultInstructions(toolNameMap: ReadonlyMap<string, string>): string {
  const names = getModelFacingToolNames(toolNameMap);
  const workspaceInspectionInstruction = names.listWorkspaceContext
    ? `First inspect available selected context, token budgets, Tapestry ranges, project-tree token counts, and the workspace index hint with ${names.listWorkspaceContext}.`
    : 'Workspace-selection inspection is unavailable in this run.';
  const semanticSearchInstruction =
    names.listEmbeddingSpaces && names.queryEmbeddingSpace
      ? `For broad codebase questions, call ${names.listEmbeddingSpaces} and prefer the space marked recommendedForWorkspaceSearch because it is the workspace index; then pass that explicit embeddingSetId to ${names.queryEmbeddingSpace}.`
      : 'Semantic workspace search is unavailable unless both listEmbeddingSpaces and queryEmbeddingSpace are registered.';
  const readContextInstruction =
    names.readWorkspaceContext && names.readWorkspaceFile
      ? `Use ${names.readWorkspaceContext} or ${names.readWorkspaceFile} afterward when you need surrounding file contents beyond the retrieved source line ranges.`
      : names.readWorkspaceFile
        ? `Use ${names.readWorkspaceFile} afterward when you need surrounding file contents beyond retrieved source line ranges.`
        : 'Workspace file reading is unavailable in this run.';
  const curationInstruction =
    names.queryEmbeddingSpace &&
    names.updateWorkspaceContextSelection &&
    names.updateWorkspaceTapestrySelections
      ? `When the user asks you to curate ideal reusable context, use ${names.queryEmbeddingSpace} to find candidate files and semantic chunks with persisted source line ranges, then call ${names.updateWorkspaceContextSelection} to bulk select files and ${names.updateWorkspaceTapestrySelections} to keep only relevant line ranges. Read files when surrounding lines are needed to refine the ranges. Keep the curation token-aware and prefer Tapestry ranges over whole files when a whole file would waste context.`
      : 'Reusable context curation is unavailable unless semantic search, workspace selection, and Tapestry selection tools are all registered.';

  const selectionDefaultInstruction =
    names.updateWorkspaceTapestrySelections && names.updateWorkspaceContextSelection
      ? `When the user asks you to select, add, or curate context, default to precise Tapestry line ranges with ${names.updateWorkspaceTapestrySelections}: select only the lines that matter, not whole files. Use ${names.updateWorkspaceContextSelection} for whole-file selection only when the entire file is genuinely needed.`
      : 'Precise context selection is unavailable unless the workspace selection and Tapestry selection tools are registered.';
  const tapestryMechanicsInstruction =
    names.queryEmbeddingSpace && names.updateWorkspaceTapestrySelections
      ? `${names.queryEmbeddingSpace} results include 1-based source line ranges per chunk; pass those directly as ranges: [{ startLine, endLine }] (1-based, inclusive) to ${names.updateWorkspaceTapestrySelections}.`
      : '';
  const selectionLine = [selectionDefaultInstruction, tapestryMechanicsInstruction]
    .filter(Boolean)
    .join(' ');

  return `You are a helpful assistant for the Brainstrike IDE.
${HARNESS_FRAMING}
Use tools when they help you answer accurately.
Project files, context explorer selections, file trees, token estimates, and embedding spaces are not preloaded into your prompt.
Registered Brainstrike native context tools in this run: ${formatAvailableToolNames(names)}.
When project or codebase context is needed, use registered Brainstrike native tools explicitly. ${workspaceInspectionInstruction} ${semanticSearchInstruction} ${readContextInstruction}
${curationInstruction}
${selectionLine}
Do not assume selected files or embedding spaces are already included. Keep file and retrieval budgets small, and report skipped or truncated tool results when they affect the answer.
If an expected Brainstrike native tool is unavailable, say exactly which tool ID is missing and continue with another available tool only when that still answers the user.
If the user asks what tools you have available, list the tool IDs you can call in this session and briefly describe each one.
Only run state-changing tools after the user confirms.
Provide concise answers after using tools.`;
}
