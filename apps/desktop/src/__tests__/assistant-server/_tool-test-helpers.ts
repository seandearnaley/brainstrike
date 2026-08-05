import type { RuntimeData } from '@brainstrike/agent';

type MastraTools = NonNullable<RuntimeData['mastraTools']>;
type MastraTool = MastraTools[string];

// Mastra's ToolsInput erases each tool's concrete signature to a union whose
// execute is optional and takes (params, options). Desktop's tools ignore the
// options argument, and every value flowing through the erased signature is
// already `any` upstream — the `any` here mirrors that, it does not add any.
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
 * Returns the tool's execute bound to the single-argument call shape the
 * existing tests use. Mastra's type requires a second `options` argument that
 * desktop's tool implementations never read; passing `{}` keeps the call
 * type-correct without changing observable behavior.
 */
export function requireToolExecute(
  tools: MastraTools,
  id: string
): (params: unknown) => ReturnType<ErasedExecute> {
  const tool = requireTool(tools, id);
  const execute = (tool as { execute?: ErasedExecute }).execute;
  if (typeof execute !== 'function') {
    throw new Error(`Expected tool '${id}' to have an execute implementation`);
  }
  return (params: unknown) => execute.call(tool, params, {});
}
