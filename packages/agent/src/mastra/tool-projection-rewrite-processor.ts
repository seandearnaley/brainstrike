import { createLogger } from '@brainstrike/logging';
import type {
  ProcessLLMRequestArgs,
  ProcessLLMRequestResult,
  Processor,
} from '@mastra/core/processors';
import type { ToolProjectionRewriteLookup } from '../types';

const logger = createLogger('ToolProjectionRewriteProcessor');
type Prompt = ProcessLLMRequestArgs['prompt'];
type AssistantOrToolMessage = Extract<Prompt[number], { role: 'assistant' | 'tool' }>;
type RewritablePart = AssistantOrToolMessage['content'][number];

function collectPresentToolCallIds(prompt: Prompt): Set<string> {
  const present = new Set<string>();
  for (const message of prompt) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (
        (part.type === 'tool-call' || part.type === 'tool-result') &&
        typeof part.toolCallId === 'string' &&
        part.toolCallId.length > 0
      ) {
        present.add(part.toolCallId);
      }
    }
  }
  return present;
}

/**
 * Applies durable overlay rows only at the transient provider boundary.
 *
 * A row is active for this request only while its superseding call is still
 * present in the already-tombstone-filtered prompt. Rewinding that later call
 * away therefore restores the original result without an undo log or any
 * mutation of Mastra-owned message content.
 */
export class ToolProjectionRewriteProcessor implements Processor<'tool-projection-rewrite'> {
  readonly id = 'tool-projection-rewrite';
  readonly name = 'Tool projection stale-read rewriting';

  constructor(
    private readonly threadId: string,
    private readonly lookup: ToolProjectionRewriteLookup
  ) {}

  async processLLMRequest(
    args: ProcessLLMRequestArgs
  ): Promise<ProcessLLMRequestResult | undefined> {
    const rewrites = await this.lookup.listActiveRewrites(this.threadId);
    if (rewrites.size === 0) {
      return;
    }
    const presentToolCallIds = collectPresentToolCallIds(args.prompt);
    let rewrittenCount = 0;
    const rewritePart = <Part extends RewritablePart>(part: Part): Part => {
      if (part.type !== 'tool-result' || !part.toolCallId) {
        return part;
      }
      const rewrite = rewrites.get(part.toolCallId);
      if (!rewrite) {
        return part;
      }
      if (!rewrite.markerText.trim()) {
        throw new Error('Tool projection rewrite marker must be non-empty.');
      }
      if (!presentToolCallIds.has(rewrite.supersededByToolCallId)) {
        return part;
      }
      rewrittenCount += 1;
      return {
        ...part,
        output: { type: 'text' as const, value: rewrite.markerText },
      } as Part;
    };
    const prompt = args.prompt.map((message) => {
      if (message.role === 'tool') {
        const content = message.content.map(rewritePart);
        const contentChanged = content.some((part, index) => part !== message.content[index]);
        return contentChanged ? { ...message, content } : message;
      }
      if (message.role !== 'assistant') {
        return message;
      }
      const content = message.content.map(rewritePart);
      const contentChanged = content.some((part, index) => part !== message.content[index]);
      return contentChanged ? { ...message, content } : message;
    });
    if (rewrittenCount === 0) {
      return;
    }
    logger.info(
      { code: 'tool_projection_history_rewritten', rewrittenCount, threadId: this.threadId },
      'rewrote superseded native-tool projections for provider replay'
    );
    return { prompt };
  }
}

export function buildToolProjectionRewriteInputProcessor(
  lookup: ToolProjectionRewriteLookup | undefined,
  threadId: string | undefined
): Processor | undefined {
  if (!(lookup && threadId?.trim())) {
    return;
  }
  return new ToolProjectionRewriteProcessor(threadId, lookup);
}
