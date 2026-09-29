import { parseMemoryRequestContext } from '@mastra/core/memory';
import type { OutputProcessor } from '@mastra/core/processors';
import type { ChildContinuationHostPort } from './child-continuation-host-port';

export interface ChildContinuationRuntimeScope {
  readonly resourceId: string;
  readonly threadId: string;
  readonly usageProcessor?: ContinuationUsageProcessor;
}

export type ContinuationUsageProcessor = OutputProcessor & {
  readUsage(): { promptTokens: number; completionTokens: number } | undefined;
};

/** Meter completed model responses before a tool can suspend or be cancelled. */
export function createContinuationUsageProcessor(
  host: ChildContinuationHostPort,
  id: string,
  scope: ChildContinuationRuntimeScope
): ContinuationUsageProcessor {
  let reported = false;
  let inputTokens = 0;
  let outputTokens = 0;
  return {
    id: 'brainstrike-continuation-usage',
    async processOutputStep({ usage, messages, requestContext }) {
      const native = parseMemoryRequestContext(requestContext);
      if (native?.resourceId !== scope.resourceId || native.thread?.id !== scope.threadId) {
        throw new Error('Continuation usage differs from its admitted native child.');
      }
      if (usage.inputTokens === undefined || usage.outputTokens === undefined) {
        return messages;
      }
      reported = true;
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      await host.persistContinuationUsage({ id, inputTokens, outputTokens });
      return messages;
    },
    readUsage() {
      return reported ? { completionTokens: outputTokens, promptTokens: inputTokens } : undefined;
    },
  };
}
