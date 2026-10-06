import { createLogger } from '@brainstrike/logging';
import type {
  ProcessLLMRequestArgs,
  ProcessLLMRequestResult,
  Processor,
} from '@mastra/core/processors';
import type { ToolProjectionRewriteEntry, ToolProjectionRewriteLookup } from '../types';

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

/** Canonical transient rewrite; shared by the Mastra processor and SDK host. */
export function rewriteToolProjectionPrompt(
  inputPrompt: Prompt,
  rewrites: ReadonlyMap<string, ToolProjectionRewriteEntry>
): { prompt: Prompt; rewrittenCount: number } {
  const presentToolCallIds = collectPresentToolCallIds(inputPrompt);
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
    if (
      rewrite.kind === 'supersession' &&
      !presentToolCallIds.has(rewrite.supersededByToolCallId)
    ) {
      return part;
    }
    rewrittenCount += 1;
    return {
      ...part,
      output: { type: 'text' as const, value: rewrite.markerText },
    } as Part;
  };
  const prompt = inputPrompt.map((message) => {
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
  return { prompt, rewrittenCount };
}

/**
 * Applies durable overlay rows only at the transient provider boundary.
 *
 * Supersession rows are active only while their superseding call remains in
 * the already-tombstone-filtered prompt. Prune rows have no superseder and
 * remain active whenever their own call is present. Neither kind mutates
 * Mastra-owned message content.
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
    const { prompt, rewrittenCount } = rewriteToolProjectionPrompt(args.prompt, rewrites);
    if (rewrittenCount === 0) {
      return;
    }
    logger.info(
      { code: 'tool_projection_history_rewritten', rewrittenCount, threadId: this.threadId },
      'rewrote overlaid native-tool projections for provider replay'
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
