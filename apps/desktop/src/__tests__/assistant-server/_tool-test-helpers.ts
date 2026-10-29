import type { RuntimeData } from '@brainstrike/agent';
import type { HostToolDefinitions } from '@brainstrike/agent/tool-runtime';

type NativeToolDefinitions = HostToolDefinitions;
type NativeToolDefinition = NativeToolDefinitions[string];

/**
 * Models the authoritative server-side root enrichment for direct tool tests.
 * Product requests obtain the same inventory from the desktop roots table.
 */
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
export function requireTool(tools: NativeToolDefinitions, id: string): NativeToolDefinition {
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
  tools: NativeToolDefinitions,
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
