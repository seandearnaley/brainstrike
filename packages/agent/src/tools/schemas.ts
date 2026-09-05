import {
  type DesktopNativeToolId,
  isDesktopNativeToolId,
  NATIVE_TOOL_ID,
  WEB_EXTRACT_TOOL_ID,
  WEB_SEARCH_TOOL_ID,
} from '@brainstrike/assistant-contract/tool-metadata';
import type { z } from 'zod';
import {
  type ProviderCompatibleInputSchema,
  providerCompatibleInputSchema,
} from './provider-compatible-input';
import { ReadToolOutputArtifactCursorInputSchema } from './schemas-artifacts';
import {
  BrowserGetPageTextInputSchema,
  BrowserNavigateInputSchema,
  BrowserReadPageInputSchema,
} from './schemas-browser';
import {
  ListEmbeddingSetsInputSchema,
  QueryDiagnosticsInputSchema,
  QuerySelfInputSchema,
} from './schemas-diagnostics';
import {
  ExecuteCommandInputSchema,
  InspectCommandSessionsInputSchema,
  ManageCommandSessionInputSchema,
  RunPythonInputSchema,
  RunSkillScriptInputSchema,
} from './schemas-execution';
import {
  GlobWorkspaceInputSchema,
  GrepSearchInputSchema,
  HybridSearchInputSchema,
  LspInspectInputSchema,
  QueryEmbeddingSpaceInputSchema,
  WebExtractInputSchema,
  WebSearchInputSchema,
} from './schemas-search';
import {
  AskUserInputSchema,
  ManageTaskListInputSchema,
  SubmitPlanInputSchema,
} from './schemas-tasks';
import {
  DeleteWorkspaceFileInputSchema,
  FindWorkspaceSymbolInputSchema,
  ListWorkspaceContextInputSchema,
  ManageCanvasInputSchema,
  ReadWorkspaceContextInputSchema,
  ReadWorkspaceDirectoryInputSchema,
  ReadWorkspaceFileInputSchema,
  RenameWorkspaceFileInputSchema,
  StringReplaceWorkspaceFileInputSchema,
  UpdateWorkspaceContextSelectionInputSchema,
  UpdateWorkspaceTapestrySelectionsInputSchema,
  WriteWorkspaceFileInputSchema,
} from './schemas-workspace';
import { ListWorktreesInputSchema, ManageWorktreeInputSchema } from './schemas-worktrees';

export * from './schemas-browser';
export * from './schemas-diagnostics';
export * from './schemas-execution';
export * from './schemas-search';
export * from './schemas-tasks';
export * from './schemas-workspace';
export * from './schemas-worktrees';

export const NATIVE_TOOL_INPUT_SCHEMAS = {
  [NATIVE_TOOL_ID.askUser]: AskUserInputSchema,
  [NATIVE_TOOL_ID.browserGetPageText]: providerCompatibleInputSchema(BrowserGetPageTextInputSchema),
  [NATIVE_TOOL_ID.browserNavigate]: providerCompatibleInputSchema(BrowserNavigateInputSchema),
  [NATIVE_TOOL_ID.browserReadPage]: providerCompatibleInputSchema(BrowserReadPageInputSchema),
  [NATIVE_TOOL_ID.deleteWorkspaceFile]: providerCompatibleInputSchema(
    DeleteWorkspaceFileInputSchema
  ),
  [NATIVE_TOOL_ID.executeCommand]: providerCompatibleInputSchema(ExecuteCommandInputSchema),
  [NATIVE_TOOL_ID.findWorkspaceSymbol]: providerCompatibleInputSchema(
    FindWorkspaceSymbolInputSchema
  ),
  [NATIVE_TOOL_ID.globWorkspace]: providerCompatibleInputSchema(GlobWorkspaceInputSchema),
  [NATIVE_TOOL_ID.grepSearch]: providerCompatibleInputSchema(GrepSearchInputSchema),
  [NATIVE_TOOL_ID.hybridSearch]: providerCompatibleInputSchema(HybridSearchInputSchema),
  [NATIVE_TOOL_ID.inspectCommandSessions]: providerCompatibleInputSchema(
    InspectCommandSessionsInputSchema
  ),
  [NATIVE_TOOL_ID.listEmbeddingSpaces]: providerCompatibleInputSchema(ListEmbeddingSetsInputSchema),
  [NATIVE_TOOL_ID.listWorkspaceContext]: providerCompatibleInputSchema(
    ListWorkspaceContextInputSchema
  ),
  [NATIVE_TOOL_ID.listWorktrees]: providerCompatibleInputSchema(ListWorktreesInputSchema),
  [NATIVE_TOOL_ID.lspInspect]: providerCompatibleInputSchema(LspInspectInputSchema),
  [NATIVE_TOOL_ID.manageCanvas]: providerCompatibleInputSchema(ManageCanvasInputSchema),
  [NATIVE_TOOL_ID.manageCommandSession]: providerCompatibleInputSchema(
    ManageCommandSessionInputSchema
  ),
  [NATIVE_TOOL_ID.manageTaskList]: providerCompatibleInputSchema(ManageTaskListInputSchema),
  [NATIVE_TOOL_ID.manageWorktree]: providerCompatibleInputSchema(ManageWorktreeInputSchema),
  [NATIVE_TOOL_ID.queryDiagnostics]: providerCompatibleInputSchema(QueryDiagnosticsInputSchema),
  [NATIVE_TOOL_ID.queryEmbeddingSpace]: providerCompatibleInputSchema(
    QueryEmbeddingSpaceInputSchema
  ),
  [NATIVE_TOOL_ID.querySelf]: providerCompatibleInputSchema(QuerySelfInputSchema),
  [NATIVE_TOOL_ID.readToolOutputArtifact]: providerCompatibleInputSchema(
    ReadToolOutputArtifactCursorInputSchema
  ),
  [NATIVE_TOOL_ID.readWorkspaceContext]: providerCompatibleInputSchema(
    ReadWorkspaceContextInputSchema
  ),
  [NATIVE_TOOL_ID.readWorkspaceDirectory]: providerCompatibleInputSchema(
    ReadWorkspaceDirectoryInputSchema
  ),
  [NATIVE_TOOL_ID.readWorkspaceFile]: providerCompatibleInputSchema(ReadWorkspaceFileInputSchema),
  [NATIVE_TOOL_ID.renameWorkspaceFile]: providerCompatibleInputSchema(
    RenameWorkspaceFileInputSchema
  ),
  [NATIVE_TOOL_ID.runPython]: RunPythonInputSchema,
  [NATIVE_TOOL_ID.runSkillScript]: providerCompatibleInputSchema(RunSkillScriptInputSchema),
  [NATIVE_TOOL_ID.stringReplaceWorkspaceFile]: providerCompatibleInputSchema(
    StringReplaceWorkspaceFileInputSchema
  ),
  [NATIVE_TOOL_ID.submitPlan]: SubmitPlanInputSchema,
  [NATIVE_TOOL_ID.updateWorkspaceContextSelection]: providerCompatibleInputSchema(
    UpdateWorkspaceContextSelectionInputSchema
  ),
  [NATIVE_TOOL_ID.updateWorkspaceTapestrySelections]: providerCompatibleInputSchema(
    UpdateWorkspaceTapestrySelectionsInputSchema
  ),
  [WEB_EXTRACT_TOOL_ID]: providerCompatibleInputSchema(WebExtractInputSchema),
  [WEB_SEARCH_TOOL_ID]: providerCompatibleInputSchema(WebSearchInputSchema),
  [NATIVE_TOOL_ID.writeWorkspaceFile]: providerCompatibleInputSchema(WriteWorkspaceFileInputSchema),
} as const satisfies Record<DesktopNativeToolId, ProviderCompatibleInputSchema>;

function formatZodIssue(issue: z.ZodIssue): string {
  const path = Array.isArray(issue.path) ? issue.path.join('.') : String(issue.path);
  const prefix = path.length > 0 ? `${path} ` : '';
  return `${prefix}${issue.message}`;
}

function parseWithSchema(
  schema: z.ZodSchema,
  params: Record<string, unknown> | undefined
): { ok: true; data: unknown } | { ok: false; issues: string[] } {
  const res = schema.safeParse(params ?? {});
  if (!res.success) {
    return {
      issues: res.error.issues.map((issue) => formatZodIssue(issue)),
      ok: false,
    };
  }
  return { data: res.data, ok: true };
}

export function validateToolInput(
  name: string,
  params: Record<string, unknown> | undefined
): { ok: true; data: unknown } | { ok: false; issues: string[] } {
  try {
    const schema = isDesktopNativeToolId(name) ? NATIVE_TOOL_INPUT_SCHEMAS[name] : undefined;
    if (schema) {
      return parseWithSchema(schema, params);
    }
    // Only canonical BrainStrike-native tool IDs are validated here.
    // Runtime-discovered MCP tools must keep their server-provided names and are
    // forwarded without local aliasing or fallback validation.
    return { data: params ?? {}, ok: true };
  } catch (err) {
    return { issues: [err instanceof Error ? err.message : String(err)], ok: false };
  }
}
