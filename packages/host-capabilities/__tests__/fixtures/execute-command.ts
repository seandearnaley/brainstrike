import { createRequire } from 'node:module';
import type { RuntimeData } from '@brainstrike/agent';
import { CEILING_SCALED_TOOL_RESULT_BUDGET } from '@brainstrike/agent/tool-runtime';
import {
  type ExecuteCommandShell,
  type ExecuteCommandToolResult,
  executeCommandExecutor,
  type NativeToolDefinition,
  ReadWorkspaceFileCursorRegistry,
} from '../../src/native-tools/index.js';

/** The standalone host's wrapper: `@brainstrike/host-capabilities/windows-command-entry`. */
export const packageWindowsCommandEntry = (): string =>
  createRequire(import.meta.url).resolve('@brainstrike/host-capabilities/windows-command-entry');

/** One workspace root whose id is its path, as the standalone host's launch roots are. */
export function singleRootRuntime(rootPath: string): RuntimeData {
  return {
    workspaceRootPath: rootPath,
    workspaceRoots: [
      {
        displayName: rootPath.split(/[\\/]/u).filter(Boolean).at(-1) ?? rootPath,
        path: rootPath,
        rootId: rootPath,
      },
    ],
  } as RuntimeData;
}

/** The executor's definition for one call, built over a minimal shared context. */
export function executeCommandTool(
  runtimeData: RuntimeData,
  shell: Partial<ExecuteCommandShell> = {}
): NativeToolDefinition & {
  readonly execute: (input: unknown, options?: unknown) => Promise<ExecuteCommandToolResult>;
  readonly toModelOutput: (output: unknown) => unknown;
} {
  const budget = CEILING_SCALED_TOOL_RESULT_BUDGET.domainModelResultCharBudget;
  const definition = executeCommandExecutor({
    windowsCommandEntry: packageWindowsCommandEntry,
    ...shell,
  })({
    ports: {
      artifactReader: undefined,
      canvas: undefined,
      fileMutations: {
        edits: () => {
          throw new Error('executeCommand never edits through the tracker');
        },
      },
      taskList: undefined,
    },
    readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
    resolveActiveDomainCharBudget: () => budget,
    resolvedDomainCharBudget: budget,
    runtimeData,
  });
  if (!(definition?.execute && definition.toModelOutput)) {
    throw new Error('The executeCommand executor built no executable definition');
  }
  return definition as ReturnType<typeof executeCommandTool>;
}
