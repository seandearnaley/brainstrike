import { type ToolSet, tool } from 'ai';
import { approvalRuntimeSchema } from './approval-input.js';
import type { HostTool } from './ports.js';

/** Public SDK shape only; the supplied callbacks retain HostCore admission and dispatch. */
export function createHostSdkTools(options: {
  readonly admittedInput: (
    toolId: string,
    rawInput: unknown
  ) => { readonly value: unknown } | undefined;
  readonly execute: (toolId: string, toolCallId: string, input: unknown) => Promise<unknown>;
  readonly tools: Readonly<Record<string, HostTool>>;
}): ToolSet {
  const tools: ToolSet = {};
  for (const [id, registered] of Object.entries(options.tools)) {
    const definition = {
      description: registered.description,
      inputSchema: approvalRuntimeSchema(registered.inputSchema, (rawInput) =>
        options.admittedInput(id, rawInput)
      ),
      ...(registered.strict === undefined ? {} : { strict: registered.strict }),
    };
    tools[id] = registered.interaction
      ? tool(definition)
      : tool({
          ...definition,
          execute: (input, context) => options.execute(id, context.toolCallId, input),
          ...(registered.toModelOutput ? { toModelOutput: registered.toModelOutput } : {}),
        });
  }
  return tools;
}
