import type {
  ProcessInputStepArgs,
  ProcessLLMRequestArgs,
  Processor,
} from '@mastra/core/processors';
import type { RuntimeData } from '../types';
import type { MastraAgentRuntime } from './agent-runtime';
import {
  type BackgroundLedgerSource,
  createBackgroundLedgerSource,
  describeBackgroundWakeup,
  personaLabelFor,
  requireBackgroundGeneration,
} from './background-ledger';
import type { DelegationOutcomeCapture } from './subagent-delegation';

/** Created by buildStreamOptions for each stream/resume leg; never shared across turns. */
export function createActiveBackgroundResultsProcessor(
  runtime: MastraAgentRuntime,
  runtimeData: RuntimeData | undefined,
  rejectedDelegations: DelegationOutcomeCapture | undefined
): ActiveBackgroundResultsProcessor | undefined {
  const manager = runtime.backgroundTaskManager;
  if (!manager || runtime.childExecution) {
    return;
  }
  const scope = runtimeData?.memory;
  if (!scope) {
    throw new Error('Background results require the original root memory scope.');
  }
  const source = createBackgroundLedgerSource({
    generation: requireBackgroundGeneration(runtime.conversationBinding),
    manager,
    personaLabel: personaLabelFor(runtime),
    rejectedDelegations,
    resolveInvocation: runtime.conversationBinding?.resolveParkedInvocation,
    scope,
  });
  return new ActiveBackgroundResultsProcessor(source);
}

export class ActiveBackgroundResultsProcessor implements Processor<'active-background-results'> {
  readonly id = 'active-background-results';
  private readonly presented = new Set<string>();
  private inputCreatedAt: Date | undefined;
  constructor(private readonly source: BackgroundLedgerSource) {}

  hasPresented(taskId: string): boolean {
    return this.presented.has(taskId);
  }

  async processInputStep({ messageList, state }: ProcessInputStepArgs) {
    const ledger = await this.source.read(new Set());
    const messageId = `active-background-results:${ledger.ledgerId}`;
    state['notice'] = undefined;
    state['terminalTaskIds'] = [];
    if (ledger.entries.length === 0) {
      messageList.removeByIds([messageId]);
      return messageList;
    }
    // Native context is not drained as a new user/response message. Replace this
    // owned entry before the token limiter, without persisting a turn or waking a model.
    // Include compact saved outcomes even when compaction removed their tool pairs.
    const outcomes = ledger.entries.flatMap((entry) =>
      entry.outcome
        ? [
            {
              output: entry.outcome,
              toolCallId: entry.toolCallId,
              toolName: entry.toolName,
            },
          ]
        : []
    );
    const content =
      describeBackgroundWakeup(ledger) +
      (outcomes.length > 0
        ? `\nSaved terminal outcomes (tool result data):\n${JSON.stringify(outcomes)}`
        : '');
    state['notice'] = content;
    state['terminalTaskIds'] = ledger.entries.flatMap((entry) =>
      entry.outcome && entry.taskId ? [entry.taskId] : []
    );
    // This is a refreshed state snapshot for the current input, not a
    // chronological execution event or a new user turn. Native
    // response rows can span many steps, so a wall-clock timestamp here would
    // place the same notice AFTER every memory update in that response.
    const input = messageList.get.all
      .db()
      .findLast((message) => message.role === 'user' && message.id !== messageId);
    if (input) {
      this.inputCreatedAt = input.createdAt;
    }
    if (!this.inputCreatedAt) {
      throw new Error('Background context requires an owning user input.');
    }
    messageList.removeByIds([messageId]);
    messageList.add(
      [
        {
          content: { format: 2, parts: [{ text: content, type: 'text' }] },
          createdAt: this.inputCreatedAt,
          id: messageId,
          role: 'user',
        },
      ],
      'context'
    );
    return messageList;
  }

  processLLMRequest({ prompt, state }: ProcessLLMRequestArgs): void {
    const notice = state['notice'];
    const taskIds = state['terminalTaskIds'];
    if (typeof notice !== 'string' || !Array.isArray(taskIds)) {
      return;
    }
    // Only acknowledge context that survived the limiter and other input processors.
    if (
      !prompt.some(
        (message) =>
          message.role === 'user' &&
          message.content.some((part) => part.type === 'text' && part.text === notice)
      )
    ) {
      return;
    }
    for (const taskId of taskIds) {
      if (typeof taskId === 'string') {
        this.presented.add(taskId);
      }
    }
  }
}

export function wasBackgroundOutcomePresented(
  processors: readonly unknown[] | undefined,
  taskId: string
): boolean {
  return (
    processors?.some(
      (processor) =>
        processor instanceof ActiveBackgroundResultsProcessor && processor.hasPresented(taskId)
    ) ?? false
  );
}
