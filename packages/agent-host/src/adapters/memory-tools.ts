import { isStandardSchemaWithJSON } from '@mastra/core/schema';
import { Memory } from '@mastra/memory';
import type { HostTool } from '../ports.js';
import type { HostMemory } from './memory.js';
import type { StateStoreHostMemoryOptions } from './state-store-host-memory.js';

/**
 * The public Memory configuration's own model-facing tools (`Memory.listTools`):
 * working-memory updates and observational recall. Mastra's injected memory
 * instructions name these tools, so the host declares exactly the vendor set.
 *
 * Declarations come from a storage-less Memory over the same public
 * configuration, because the host fixes its tool set at admission, before the
 * run owns a Memory. Each call executes the vendor tool against the run's own
 * admitted HostMemory (`memory(runId)`), never this declaration instance.
 * Working memory is host memory bookkeeping (legacy never prompted for it), so
 * every Memory tool takes the `read` risk category.
 */
export function hostMemoryTools(
  native: StateStoreHostMemoryOptions['native'],
  memory: (runId: string) => Promise<HostMemory>
): Record<string, HostTool> {
  const declared = new Memory({
    ...(native.embedder ? { embedder: native.embedder } : {}),
    ...(native.options ? { options: native.options } : {}),
    ...(native.vector ? { vector: native.vector } : {}),
  }).listTools();
  return Object.fromEntries(
    Object.entries(declared).map(([name, tool]): [string, HostTool] => {
      // The vendor Tool already normalized its schema; the SDK consumes it directly.
      if (!isStandardSchemaWithJSON(tool.inputSchema)) {
        throw new Error(`Native Memory tool ${name} has no standard JSON input schema`);
      }
      return [
        name,
        {
          description: tool.description,
          execute: async (input, context) =>
            (await memory(context.runId)).executeTool(name, input, context.toolCallId),
          identity: `mastra-memory:${tool.id}`,
          inputSchema: tool.inputSchema,
          risk: 'read',
          ...(tool.strict === undefined ? {} : { strict: tool.strict }),
        },
      ];
    })
  );
}
