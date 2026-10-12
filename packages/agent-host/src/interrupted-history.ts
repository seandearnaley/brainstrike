import { healInterruptedModelMessages } from '@brainstrike/agent/provider-request';
import type { ModelMessage } from 'ai';
import type { HostRunState } from './core-state.js';

/** Repair a provider view only for existing committed interrupted run occurrences. */
export function healInterruptedRunHistory(
  messages: readonly ModelMessage[],
  runs: readonly HostRunState[],
  threadId: string
): ModelMessage[] {
  const spans = runs
    .flatMap((run) => {
      if (run.threadId !== threadId || !(run.stopped || run.outcome === 'interrupted')) {
        return [];
      }
      const indexes = [...run.messageIndexes].sort((left, right) => left - right);
      const first = indexes[0];
      const last = indexes.at(-1);
      return first === undefined || last === undefined ? [] : [{ first, last }];
    })
    .sort((left, right) => right.first - left.first);
  const prepared = [...messages];
  for (const { first, last } of spans) {
    const occurrence = prepared.slice(first, last + 1);
    const calls = new Set(
      occurrence.flatMap((message) =>
        message.role === 'assistant' && typeof message.content !== 'string'
          ? message.content.flatMap((part) => (part.type === 'tool-call' ? [part.toolCallId] : []))
          : []
      )
    );
    prepared.splice(first, occurrence.length, ...healInterruptedModelMessages(occurrence, calls));
  }
  return prepared;
}
