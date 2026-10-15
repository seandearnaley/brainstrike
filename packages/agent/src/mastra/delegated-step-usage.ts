import { parseMemoryRequestContext } from '@mastra/core/memory';
import type { OutputProcessor } from '@mastra/core/processors';
import { z } from 'zod';
import {
  readMastraStreamPartString,
  readMastraStreamPartValue,
} from '../tool-projection/tool-event-mapper';

export const DELEGATED_STEP_USAGE_PART = 'data-brainstrike-delegated-step-usage';
const usageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  resourceId: z.string().min(1),
  threadId: z.string().min(1),
});

/** Native output-step supplies prior committed steps separately from the current response. */
export function createDelegatedStepUsageProcessor(): OutputProcessor {
  return {
    id: 'brainstrike-delegated-step-usage',
    async processOutputStep({ messages, requestContext, steps, writer, usage }) {
      const native = parseMemoryRequestContext(requestContext);
      if (!(native?.resourceId && native.thread?.id && writer)) {
        throw new Error('Delegated model usage requires native memory and stream ownership.');
      }
      const counts = { inputTokens: 0, outputTokens: 0 };
      for (const response of [...steps.map((step) => step.usage), usage]) {
        if (response.inputTokens === undefined || response.outputTokens === undefined) {
          return messages;
        }
        counts.inputTokens += response.inputTokens;
        counts.outputTokens += response.outputTokens;
      }
      // Internal metering must never replace the native assistant response in memory.
      // Mastra's public transient data-part contract streams without persisting it.
      await writer.custom({
        data: usageSchema.parse({
          ...counts,
          resourceId: native.resourceId,
          threadId: native.thread.id,
        }),
        transient: true,
        type: DELEGATED_STEP_USAGE_PART,
      });
      return messages;
    },
  };
}

export function readDelegatedStepUsage(part: unknown): z.infer<typeof usageSchema> | undefined {
  return readMastraStreamPartString(part, 'type') === DELEGATED_STEP_USAGE_PART
    ? usageSchema.parse(readMastraStreamPartValue(part, 'data'))
    : undefined;
}
