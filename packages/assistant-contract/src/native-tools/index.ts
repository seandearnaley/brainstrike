/**
 * The native tool catalog: ONE list, every registry derived (BST-1646).
 *
 * `NATIVE_TOOLS` is the only place tools are enumerated. Order is the
 * canonical id order (desktop `brainstrike.*` ids alphabetically, then the
 * three Mastra skill ids), which every derived id list and discovery namespace
 * preserves. Adding a tool: create `definitions/<tool>.ts`, import it here,
 * add it to the list in order, and add its executor entry on the desktop side.
 */
import { askUser } from './definitions/ask-user.js';
import { browserGetPageText } from './definitions/browser-get-page-text.js';
import { browserNavigate } from './definitions/browser-navigate.js';
import { browserReadPage } from './definitions/browser-read-page.js';
import { deleteWorkspaceFile } from './definitions/delete-workspace-file.js';
import { executeCommand } from './definitions/execute-command.js';
import { findWorkspaceSymbol } from './definitions/find-workspace-symbol.js';
import { globWorkspace } from './definitions/glob-workspace.js';
import { grepSearch } from './definitions/grep-search.js';
import { hybridSearch } from './definitions/hybrid-search.js';
import { inspectCommandSessions } from './definitions/inspect-command-sessions.js';
import { listEmbeddingSpaces } from './definitions/list-embedding-spaces.js';
import { listWorkspaceContext } from './definitions/list-workspace-context.js';
import { listWorktrees } from './definitions/list-worktrees.js';
import { lspInspect } from './definitions/lsp-inspect.js';
import { manageCanvas } from './definitions/manage-canvas.js';
import { manageCommandSession } from './definitions/manage-command-session.js';
import { manageTaskList } from './definitions/manage-task-list.js';
import { manageWorktree } from './definitions/manage-worktree.js';
import { queryDiagnostics } from './definitions/query-diagnostics.js';
import { queryEmbeddingSpace } from './definitions/query-embedding-space.js';
import { readToolOutputArtifact } from './definitions/read-tool-output-artifact.js';
import { readWorkspaceContext } from './definitions/read-workspace-context.js';
import { readWorkspaceDirectory } from './definitions/read-workspace-directory.js';
import { readWorkspaceFile } from './definitions/read-workspace-file.js';
import { renameWorkspaceFile } from './definitions/rename-workspace-file.js';
import { runPython } from './definitions/run-python.js';
import { runSkillScript } from './definitions/run-skill-script.js';
import { skill } from './definitions/skill.js';
import { skillRead } from './definitions/skill-read.js';
import { skillSearch } from './definitions/skill-search.js';
import { stringReplaceWorkspaceFile } from './definitions/string-replace-workspace-file.js';
import { submitPlan } from './definitions/submit-plan.js';
import { updateWorkspaceContextSelection } from './definitions/update-workspace-context-selection.js';
import { updateWorkspaceTapestrySelections } from './definitions/update-workspace-tapestry-selections.js';
import { webExtract } from './definitions/web-extract.js';
import { webSearch } from './definitions/web-search.js';
import { writeWorkspaceFile } from './definitions/write-workspace-file.js';
import {
  deriveMaxNativeToolExecutionBudgetMs,
  deriveNativeToolExecutionBudgets,
  requireNativeToolExecutionBudgetFactory,
} from './execution-budgets.js';
import { deriveNativeToolRegistries } from './registries.js';

export const NATIVE_TOOLS = [
  askUser,
  browserGetPageText,
  browserNavigate,
  browserReadPage,
  deleteWorkspaceFile,
  executeCommand,
  findWorkspaceSymbol,
  globWorkspace,
  grepSearch,
  hybridSearch,
  inspectCommandSessions,
  listEmbeddingSpaces,
  listWorkspaceContext,
  listWorktrees,
  lspInspect,
  manageCanvas,
  manageCommandSession,
  manageTaskList,
  manageWorktree,
  queryDiagnostics,
  queryEmbeddingSpace,
  readToolOutputArtifact,
  readWorkspaceContext,
  readWorkspaceDirectory,
  readWorkspaceFile,
  renameWorkspaceFile,
  runPython,
  runSkillScript,
  stringReplaceWorkspaceFile,
  submitPlan,
  updateWorkspaceContextSelection,
  updateWorkspaceTapestrySelections,
  webExtract,
  webSearch,
  writeWorkspaceFile,
  skill,
  skillRead,
  skillSearch,
] as const;

export type NativeTool = (typeof NATIVE_TOOLS)[number];
export type DesktopNativeTool = Extract<NativeTool, { readonly kind: 'desktop' }>;
export type SkillNativeTool = Extract<NativeTool, { readonly kind: 'skill' }>;

/** Every registry, derived once from {@link NATIVE_TOOLS} at module load. */
export const NATIVE_TOOL_REGISTRIES = deriveNativeToolRegistries(NATIVE_TOOLS);

export const NATIVE_TOOL_EXECUTION_BUDGETS = deriveNativeToolExecutionBudgets(NATIVE_TOOLS);
export const MAX_NATIVE_TOOL_EXECUTION_BUDGET_MS = deriveMaxNativeToolExecutionBudgetMs(
  NATIVE_TOOL_EXECUTION_BUDGETS
);
/** Lookup-or-throw for one tool's declared execution budget (BST-1777). */
export const requireNativeToolExecutionBudget = requireNativeToolExecutionBudgetFactory(
  NATIVE_TOOL_EXECUTION_BUDGETS
);

/** The desktop (`brainstrike.*`) definitions in catalog order. */
export const DESKTOP_NATIVE_TOOLS: readonly DesktopNativeTool[] = Object.freeze(
  NATIVE_TOOLS.filter((tool): tool is DesktopNativeTool => tool.kind === 'desktop')
);

/** The Mastra skill-tool definitions in catalog order. */
export const SKILL_NATIVE_TOOLS: readonly SkillNativeTool[] = Object.freeze(
  NATIVE_TOOLS.filter((tool): tool is SkillNativeTool => tool.kind === 'skill')
);

export {
  DEFERRED_CAPABILITY_FAMILY_PHRASES,
  type DeferredCapabilityFamily,
  describeAvailableDeferredCapabilityFamilies,
} from './capability-families.js';
export {
  type DeferredCapabilityFamilyPhrase,
  type DesktopNativeToolDefinition,
  defineNativeTool,
  InvalidNativeToolDefinitionError,
  type NativeToolDefinition,
  type NativeToolDiscoveryNamespace,
  type NativeToolExecutionBudget,
  type NativeToolHistoryPosture,
  type NativeToolNameResolver,
  type NativeToolSurface,
  type SkillNativeToolDefinition,
} from './define.js';
export {
  deriveNativeToolRegistries,
  type NativeToolKeyOf,
  type NativeToolRegistries,
  toNativeToolKey,
} from './registries.js';
export type {
  NativeToolDefaultMetadata,
  ToolCategory,
  ToolLoadingTier,
  ToolRiskCategory,
} from './taxonomy.js';
