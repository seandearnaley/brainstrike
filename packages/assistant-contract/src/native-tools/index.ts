/**
 * The native tool catalog: ONE list, every registry derived (BST-1646).
 *
 * `NATIVE_TOOLS` is the only place tools are enumerated. Order is the
 * canonical id order (desktop `brainstrike.*` ids alphabetically, then the
 * three Mastra skill ids), which every derived id list and discovery namespace
 * preserves. Adding a tool: create `definitions/<tool>.ts`, import it here,
 * add it to the list in order, and add its executor entry on the desktop side.
 */
import { askUser } from './definitions/ask-user.ts';
import { browserClick } from './definitions/browser-click.ts';
import { browserGetPageText } from './definitions/browser-get-page-text.ts';
import { browserNavigate } from './definitions/browser-navigate.ts';
import { browserReadPage } from './definitions/browser-read-page.ts';
import { browserSelectOption } from './definitions/browser-select-option.ts';
import { browserType } from './definitions/browser-type.ts';
import { deleteWorkspaceFile } from './definitions/delete-workspace-file.ts';
import { executeCommand } from './definitions/execute-command.ts';
import { findWorkspaceSymbol } from './definitions/find-workspace-symbol.ts';
import { globWorkspace } from './definitions/glob-workspace.ts';
import { grepSearch } from './definitions/grep-search.ts';
import { hybridSearch } from './definitions/hybrid-search.ts';
import { inspectCommandSessions } from './definitions/inspect-command-sessions.ts';
import { listEmbeddingSpaces } from './definitions/list-embedding-spaces.ts';
import { listWorkspaceContext } from './definitions/list-workspace-context.ts';
import { listWorktrees } from './definitions/list-worktrees.ts';
import { lspInspect } from './definitions/lsp-inspect.ts';
import { manageCanvas } from './definitions/manage-canvas.ts';
import { manageCommandSession } from './definitions/manage-command-session.ts';
import { manageTaskList } from './definitions/manage-task-list.ts';
import { manageWorktree } from './definitions/manage-worktree.ts';
import { queryDiagnostics } from './definitions/query-diagnostics.ts';
import { queryEmbeddingSpace } from './definitions/query-embedding-space.ts';
import { readToolOutputArtifact } from './definitions/read-tool-output-artifact.ts';
import { readWorkspaceContext } from './definitions/read-workspace-context.ts';
import { readWorkspaceDirectory } from './definitions/read-workspace-directory.ts';
import { readWorkspaceFile } from './definitions/read-workspace-file.ts';
import { renameWorkspaceFile } from './definitions/rename-workspace-file.ts';
import { runPython } from './definitions/run-python.ts';
import { runSkillScript } from './definitions/run-skill-script.ts';
import { skill } from './definitions/skill.ts';
import { skillRead } from './definitions/skill-read.ts';
import { skillSearch } from './definitions/skill-search.ts';
import { stringReplaceWorkspaceFile } from './definitions/string-replace-workspace-file.ts';
import { submitPlan } from './definitions/submit-plan.ts';
import { webExtract } from './definitions/web-extract.ts';
import { webSearch } from './definitions/web-search.ts';
import { writeWorkspaceFile } from './definitions/write-workspace-file.ts';
import {
  deriveNativeToolExecutionBudgets,
  requireNativeToolExecutionBudgetFactory,
} from './execution-budgets.ts';
import { deriveNativeToolRegistries } from './registries.ts';

export const NATIVE_TOOLS = [
  askUser,
  browserClick,
  browserGetPageText,
  browserNavigate,
  browserReadPage,
  browserSelectOption,
  browserType,
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
} from './capability-families.ts';
export {
  type ActivityFileCountMode,
  type DeferredCapabilityFamilyPhrase,
  type DesktopNativeToolDefinition,
  defineNativeTool,
  InvalidNativeToolDefinitionError,
  type NativeToolActivity,
  type NativeToolDefinition,
  type NativeToolDiscoveryNamespace,
  type NativeToolExecutionBudget,
  type NativeToolHistoryPosture,
  type NativeToolNameResolver,
  type NativeToolSurface,
  type SkillNativeToolDefinition,
  VERB_FAMILIES,
  type VerbFamily,
} from './define.ts';
export {
  deriveNativeToolRegistries,
  type NativeToolKeyOf,
  type NativeToolRegistries,
  toNativeToolKey,
} from './registries.ts';
