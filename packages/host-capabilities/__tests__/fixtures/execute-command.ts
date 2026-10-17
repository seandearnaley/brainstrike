/**
 * Direct-call harness for the shell executor: its runtime roots, this
 * package's own Windows command wrapper (the one the standalone host ships),
 * the executor's model-facing definition, and the pid probes the process-tree
 * proofs use.
 */
import fsPromises from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { ExecuteCommandInput, RuntimeData } from '@brainstrike/agent';
import { CEILING_SCALED_TOOL_RESULT_BUDGET } from '@brainstrike/agent/tool-runtime';
import {
  type ExecuteCommandShell,
  type ExecuteCommandToolResult,
  executeCommandExecutor,
  type NativeToolDefinition,
  ReadWorkspaceFileCursorRegistry,
  runExecuteCommand,
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
        displayName: rootPath.split(/[\\/]/).filter(Boolean).at(-1) ?? rootPath,
        path: rootPath,
        rootId: rootPath,
      },
    ],
  } as RuntimeData;
}

/** {@link runExecuteCommand} with this package's Windows wrapper. */
export function runCommand(
  input: ExecuteCommandInput,
  runtimeData: RuntimeData | undefined,
  options: Omit<Parameters<typeof runExecuteCommand>[2], 'windowsCommandEntry'> = {}
): Promise<ExecuteCommandToolResult> {
  return runExecuteCommand(input, runtimeData, {
    ...options,
    windowsCommandEntry: packageWindowsCommandEntry,
  });
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
    isLocalProvider: false,
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

/** True only while the OS still has a process with this pid. */
async function pidIsAlive(pid: number): Promise<boolean> {
  try {
    // Signal 0 performs existence/permission checks without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Read a pid a shell wrote with `echo $$ > file`, tolerating the window before
 * the file exists or is fully flushed. Retries until the contents are numeric
 * and names the last non-numeric value it saw, so a timeout points at the cause.
 */
export async function readPidWhenWritten(pidFile: string, timeoutMs = 3000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let lastSeen: string | undefined;
  while (Date.now() < deadline) {
    try {
      const raw = (await fsPromises.readFile(pidFile, 'utf8')).trim();
      if (/^\d+$/.test(raw)) {
        return Number.parseInt(raw, 10);
      }
      lastSeen = JSON.stringify(raw);
    } catch (error) {
      // Only the "not written yet" race is expected here.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `pid file ${pidFile} was not readable as a pid within ${timeoutMs}ms` +
      (lastSeen === undefined ? ' (file never appeared)' : ` (last contents: ${lastSeen})`)
  );
}

export async function waitForPidDead(pid: number, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await pidIsAlive(pid))) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !(await pidIsAlive(pid));
}
