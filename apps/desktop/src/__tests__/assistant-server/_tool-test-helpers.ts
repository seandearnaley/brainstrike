import fsPromises from 'node:fs/promises';
import type { RuntimeData } from '@brainstrike/agent';

type MastraTools = NonNullable<RuntimeData['mastraTools']>;
type MastraTool = MastraTools[string];

/**
 * Models the authoritative server-side root enrichment for direct tool tests.
 * Product requests obtain the same inventory from the desktop roots table.
 */
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

// Mastra's ToolsInput erases each tool's concrete signature to a union whose
// execute is optional and takes (params, options). The comment mirrors the
// erased upstream signature — every value flowing through it is already `any`
// upstream; the `any` here does not add any.
// biome-ignore-start lint/suspicious/noExplicitAny: mirrors Mastra's erased execute signature
type ErasedExecute = (params: any, options: unknown) => Promise<any>;
// biome-ignore-end lint/suspicious/noExplicitAny: mirrors Mastra's erased execute signature

/**
 * Narrows a `tools[id]` lookup for tests: fails loudly when the tool is
 * missing (noUncheckedIndexedAccess) or has no execute implementation
 * (execute is optional on Mastra's tool union), instead of letting the
 * assertion fail later with an unrelated TypeError.
 */
export function requireTool(tools: MastraTools, id: string): MastraTool {
  const tool = tools[id];
  if (!tool) {
    throw new Error(`Expected tool '${id}' to be registered`);
  }
  return tool;
}

/**
 * Returns the tool's execute with Mastra's second `options` argument made
 * optional. Some desktop tools DO read options (executeCommand's output
 * streamer and abortSignal, runSkillScript) — pass a real context when the
 * test exercises those paths. The `{}` default matches what the pre-typed
 * tests exercised (no streamer, no signal) without changing behavior.
 *
 * `TResult` defaults to the erased `any` Mastra's own execute returns so the
 * existing suites keep their loose result assertions; pass an explicit type
 * argument to get a typed result where a test wants real checking.
 */
export function requireToolExecute<TResult = Awaited<ReturnType<ErasedExecute>>>(
  tools: MastraTools,
  id: string
): (params: unknown, options?: unknown) => Promise<TResult> {
  const tool = requireTool(tools, id);
  const execute = (tool as { execute?: ErasedExecute }).execute;
  if (typeof execute !== 'function') {
    throw new Error(`Expected tool '${id}' to have an execute implementation`);
  }
  return (params: unknown, options?: unknown) =>
    execute.call(tool, params, options ?? {}) as Promise<TResult>;
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
 * rather than yielding a NaN that only a later assertion would catch, and names
 * the last non-numeric value it saw so a timeout points at the real cause.
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
      // ONLY the "not written yet" race is expected here. A bare catch would
      // swallow real errors and surface them as an opaque timeout instead.
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
