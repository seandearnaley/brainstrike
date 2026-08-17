import { createLogger } from '@brainstrike/logging';
import type {
  ProcessInputStepArgs,
  ProcessInputStepResult,
  Processor,
} from '@mastra/core/processors';
import type { CompactionRangeEntry, CompactionRangeLookup } from '../types';

const logger = createLogger('CompactionOverlayProcessor');

export function filterMessagesByCompactionRanges<Message extends { readonly id: string }>(
  messages: readonly Message[],
  ranges: readonly CompactionRangeEntry[]
): readonly Message[] {
  if (ranges.length === 0) {
    return messages;
  }
  const presentMessageIds = new Set(messages.map((message) => message.id));
  const excludedMessageIds = new Set<string>();
  for (const range of ranges) {
    if (!presentMessageIds.has(range.compactionMessageId)) {
      continue;
    }
    for (const messageId of range.compactedMessageIds) {
      if (!messageId.trim()) {
        throw new Error('Compaction overlay message ids must be non-empty.');
      }
      if (messageId !== range.compactionMessageId && presentMessageIds.has(messageId)) {
        excludedMessageIds.add(messageId);
      }
    }
  }
  return excludedMessageIds.size === 0
    ? messages
    : messages.filter((message) => !excludedMessageIds.has(message.id));
}

/**
 * Excludes exact, already-summarized message ids at Mastra's ID-bearing input
 * seam. A range is active only while its ordinary summary message remains in
 * the current, already-tombstone-filtered message list, so rewind self-heals
 * without mutating either raw messages or overlay state.
 */
export class CompactionOverlayProcessor implements Processor<'compaction-overlay'> {
  readonly id = 'compaction-overlay';
  readonly name = 'Conversation compaction overlay';

  constructor(
    private readonly threadId: string,
    private readonly lookup: CompactionRangeLookup
  ) {}

  async processInputStep(args: ProcessInputStepArgs): Promise<ProcessInputStepResult | undefined> {
    const ranges = await this.lookup.listActiveCompactionRanges(this.threadId);
    if (ranges.length === 0) {
      return;
    }
    const messages = filterMessagesByCompactionRanges(args.messages, ranges);
    if (messages === args.messages) {
      return;
    }
    logger.info(
      {
        code: 'compaction_history_excluded',
        excludedMessages: args.messages.length - messages.length,
        threadId: this.threadId,
      },
      'excluded compacted raw messages from provider replay'
    );
    return {
      messages: [...messages],
    };
  }
}

export function buildCompactionOverlayInputProcessor(
  lookup: CompactionRangeLookup | undefined,
  threadId: string | undefined
): Processor | undefined {
  if (!(lookup && threadId?.trim())) {
    return;
  }
  return new CompactionOverlayProcessor(threadId, lookup);
}
