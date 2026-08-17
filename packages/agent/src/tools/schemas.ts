import {
  type DesktopNativeToolId,
  isDesktopNativeToolId,
  NATIVE_TOOL_ID,
  WEB_EXTRACT_TOOL_ID,
  WEB_SEARCH_TOOL_ID,
} from '@brainstrike/assistant-contract/tool-metadata';
import type { z } from 'zod';
import { ReadToolOutputArtifactCursorInputSchema } from '../mastra/tool-output-artifact-reader';
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

export * from './schemas-browser';
export * from './schemas-diagnostics';
export * from './schemas-execution';
export * from './schemas-search';
export * from './schemas-tasks';
export * from './schemas-workspace';

export const NATIVE_TOOL_INPUT_SCHEMAS = {
  [NATIVE_TOOL_ID.askUser]: AskUserInputSchema,
  [NATIVE_TOOL_ID.browserGetPageText]: BrowserGetPageTextInputSchema,
  [NATIVE_TOOL_ID.browserNavigate]: BrowserNavigateInputSchema,
  [NATIVE_TOOL_ID.browserReadPage]: BrowserReadPageInputSchema,
  [NATIVE_TOOL_ID.deleteWorkspaceFile]: DeleteWorkspaceFileInputSchema,
  [NATIVE_TOOL_ID.executeCommand]: ExecuteCommandInputSchema,
  [NATIVE_TOOL_ID.findWorkspaceSymbol]: FindWorkspaceSymbolInputSchema,
  [NATIVE_TOOL_ID.globWorkspace]: GlobWorkspaceInputSchema,
  [NATIVE_TOOL_ID.grepSearch]: GrepSearchInputSchema,
  [NATIVE_TOOL_ID.hybridSearch]: HybridSearchInputSchema,
  [NATIVE_TOOL_ID.inspectCommandSessions]: InspectCommandSessionsInputSchema,
  [NATIVE_TOOL_ID.listEmbeddingSpaces]: ListEmbeddingSetsInputSchema,
  [NATIVE_TOOL_ID.listWorkspaceContext]: ListWorkspaceContextInputSchema,
  [NATIVE_TOOL_ID.lspInspect]: LspInspectInputSchema,
  [NATIVE_TOOL_ID.manageCanvas]: ManageCanvasInputSchema,
  [NATIVE_TOOL_ID.manageCommandSession]: ManageCommandSessionInputSchema,
  [NATIVE_TOOL_ID.manageTaskList]: ManageTaskListInputSchema,
  [NATIVE_TOOL_ID.queryDiagnostics]: QueryDiagnosticsInputSchema,
  [NATIVE_TOOL_ID.queryEmbeddingSpace]: QueryEmbeddingSpaceInputSchema,
  [NATIVE_TOOL_ID.querySelf]: QuerySelfInputSchema,
  [NATIVE_TOOL_ID.readToolOutputArtifact]: ReadToolOutputArtifactCursorInputSchema,
  [NATIVE_TOOL_ID.readWorkspaceContext]: ReadWorkspaceContextInputSchema,
  [NATIVE_TOOL_ID.readWorkspaceDirectory]: ReadWorkspaceDirectoryInputSchema,
  [NATIVE_TOOL_ID.readWorkspaceFile]: ReadWorkspaceFileInputSchema,
  [NATIVE_TOOL_ID.renameWorkspaceFile]: RenameWorkspaceFileInputSchema,
  [NATIVE_TOOL_ID.runPython]: RunPythonInputSchema,
  [NATIVE_TOOL_ID.runSkillScript]: RunSkillScriptInputSchema,
  [NATIVE_TOOL_ID.stringReplaceWorkspaceFile]: StringReplaceWorkspaceFileInputSchema,
  [NATIVE_TOOL_ID.submitPlan]: SubmitPlanInputSchema,
  [NATIVE_TOOL_ID.updateWorkspaceContextSelection]: UpdateWorkspaceContextSelectionInputSchema,
  [NATIVE_TOOL_ID.updateWorkspaceTapestrySelections]: UpdateWorkspaceTapestrySelectionsInputSchema,
  [WEB_EXTRACT_TOOL_ID]: WebExtractInputSchema,
  [WEB_SEARCH_TOOL_ID]: WebSearchInputSchema,
  [NATIVE_TOOL_ID.writeWorkspaceFile]: WriteWorkspaceFileInputSchema,
} as const satisfies Record<DesktopNativeToolId, z.ZodSchema>;

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
