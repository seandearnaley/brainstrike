/**
 * Canonical native tool ids shared by browser-safe UI metadata, the hosted
 * desktop registry, and the agent runtime.
 *
 * Keep execution schemas out of this module: they are Zod/Mastra-owned and
 * therefore live in `@brainstrike/agent`. This catalog must remain safe to
 * import from renderer bundles.
 */
const DESKTOP_NATIVE_TOOL_ID = {
  askUser: 'brainstrike.askUser',
  deleteWorkspaceFile: 'brainstrike.deleteWorkspaceFile',
  executeCommand: 'brainstrike.executeCommand',
  findWorkspaceSymbol: 'brainstrike.findWorkspaceSymbol',
  globWorkspace: 'brainstrike.globWorkspace',
  grepSearch: 'brainstrike.grepSearch',
  hybridSearch: 'brainstrike.hybridSearch',
  listEmbeddingSpaces: 'brainstrike.listEmbeddingSpaces',
  listWorkspaceContext: 'brainstrike.listWorkspaceContext',
  lspInspect: 'brainstrike.lspInspect',
  manageTaskList: 'brainstrike.manageTaskList',
  queryEmbeddingSpace: 'brainstrike.queryEmbeddingSpace',
  readWorkspaceContext: 'brainstrike.readWorkspaceContext',
  readWorkspaceDirectory: 'brainstrike.readWorkspaceDirectory',
  readWorkspaceFile: 'brainstrike.readWorkspaceFile',
  renameWorkspaceFile: 'brainstrike.renameWorkspaceFile',
  stringReplaceWorkspaceFile: 'brainstrike.stringReplaceWorkspaceFile',
  submitPlan: 'brainstrike.submitPlan',
  updateWorkspaceContextSelection: 'brainstrike.updateWorkspaceContextSelection',
  updateWorkspaceTapestrySelections: 'brainstrike.updateWorkspaceTapestrySelections',
  webExtract: 'brainstrike.webExtract',
  webSearch: 'brainstrike.webSearch',
  writeWorkspaceFile: 'brainstrike.writeWorkspaceFile',
} as const;

const SKILL_NATIVE_TOOL_ID = {
  skill: 'skill',
  skillRead: 'skill_read',
  skillSearch: 'skill_search',
} as const;

export const NATIVE_TOOL_ID = {
  ...DESKTOP_NATIVE_TOOL_ID,
  ...SKILL_NATIVE_TOOL_ID,
} as const;

export type DesktopNativeToolId =
  (typeof DESKTOP_NATIVE_TOOL_ID)[keyof typeof DESKTOP_NATIVE_TOOL_ID];
export type SkillNativeToolId = (typeof SKILL_NATIVE_TOOL_ID)[keyof typeof SKILL_NATIVE_TOOL_ID];
export type NativeToolId = DesktopNativeToolId | SkillNativeToolId;

export const DESKTOP_NATIVE_TOOL_IDS: readonly DesktopNativeToolId[] = Object.freeze(
  Object.values(DESKTOP_NATIVE_TOOL_ID)
);

export const SKILL_NATIVE_TOOL_IDS: readonly SkillNativeToolId[] = Object.freeze(
  Object.values(SKILL_NATIVE_TOOL_ID)
);

export const NATIVE_TOOL_IDS: readonly NativeToolId[] = Object.freeze([
  ...DESKTOP_NATIVE_TOOL_IDS,
  ...SKILL_NATIVE_TOOL_IDS,
]);

const DESKTOP_NATIVE_TOOL_ID_SET: ReadonlySet<string> = new Set(DESKTOP_NATIVE_TOOL_IDS);
const NATIVE_TOOL_ID_SET: ReadonlySet<string> = new Set(NATIVE_TOOL_IDS);
const SKILL_NATIVE_TOOL_ID_SET: ReadonlySet<string> = new Set(SKILL_NATIVE_TOOL_IDS);

export function isDesktopNativeToolId(value: string): value is DesktopNativeToolId {
  return DESKTOP_NATIVE_TOOL_ID_SET.has(value);
}

export function isNativeToolId(value: string): value is NativeToolId {
  return NATIVE_TOOL_ID_SET.has(value);
}

export function isSkillNativeToolId(value: string): value is SkillNativeToolId {
  return SKILL_NATIVE_TOOL_ID_SET.has(value);
}
