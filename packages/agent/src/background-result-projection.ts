import type { MastraDBMessage } from '@mastra/core/agent';
import type { BackgroundTask, ResultInjector } from '@mastra/core/background-tasks';

export type BackgroundOutcome = Pick<Parameters<ResultInjector>[0], 'status' | 'result' | 'error'>;

export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function backgroundTaskReferences(message: MastraDBMessage): Map<string, string> {
  const references = new Map<string, string>();
  const metadata = record(message.content.metadata?.['backgroundTasks']);
  for (const [toolCallId, value] of Object.entries(metadata ?? {})) {
    const taskId = record(value)?.['taskId'];
    if (typeof taskId === 'string') {
      references.set(toolCallId, taskId);
    }
  }
  return references;
}

export function projectBackgroundOutcomeForModel(
  outcome: BackgroundOutcome
): { type: 'error-text'; value: string } | { type: 'text'; value: string } {
  if (outcome.status === 'failed') {
    if (!outcome.error?.message) {
      throw new Error('Failed background outcome omitted its error.');
    }
    return { type: 'error-text', value: outcome.error.message };
  }
  const result = record(outcome.result);
  return { type: 'text', value: typeof result?.['text'] === 'string' ? result['text'] : '' };
}

function withoutTerminalTranscriptTransform(
  mastraMetadata: Record<string, unknown> | undefined
): Record<string, unknown> {
  const mastra = { ...mastraMetadata };
  const transforms = record(mastra['toolPayloadTransform']);
  const transcript = record(transforms?.['transcript']);
  if (!(transforms && transcript)) {
    return mastra;
  }
  const nextTranscript = Object.fromEntries(
    Object.entries(transcript).filter(
      ([phase]) => phase !== 'error' && phase !== 'output-available'
    )
  );
  mastra['toolPayloadTransform'] = {
    ...transforms,
    transcript: nextTranscript,
  };
  return mastra;
}

export function applyBackgroundTaskOutcome(
  message: MastraDBMessage,
  task: Pick<BackgroundTask, 'id' | 'toolCallId'>,
  outcome: BackgroundOutcome
): void {
  if (backgroundTaskReferences(message).get(task.toolCallId) !== task.id) {
    throw new Error('Background result does not match its native parent invocation.');
  }
  const matchingParts = message.content.parts.filter(
    (candidate) =>
      candidate.type === 'tool-invocation' &&
      candidate.toolInvocation.toolCallId === task.toolCallId
  );
  const part = matchingParts.length === 1 ? matchingParts[0] : undefined;
  if (part?.type !== 'tool-invocation') {
    throw new Error('Background parent invocation is missing or ambiguous.');
  }
  if (outcome.status === 'failed') {
    if (!outcome.error?.message) {
      throw new Error('Failed background outcome omitted its error.');
    }
    const { result: _acknowledgement, ...previous } = part.toolInvocation;
    part.toolInvocation = { ...previous, errorText: outcome.error.message, state: 'output-error' };
  } else {
    part.toolInvocation = { ...part.toolInvocation, result: outcome.result, state: 'result' };
  }
  part.providerMetadata = {
    ...part.providerMetadata,
    mastra: {
      ...withoutTerminalTranscriptTransform(record(part.providerMetadata?.['mastra'])),
      modelOutput: projectBackgroundOutcomeForModel(outcome),
    },
  };
  const metadata = { ...message.content.metadata };
  for (const key of ['pendingToolApprovals', 'suspendedTools']) {
    if (!Object.hasOwn(metadata, key)) {
      continue;
    }
    const pending = { ...record(metadata[key]) };
    delete pending[task.toolCallId];
    metadata[key] = pending;
  }
  message.content.metadata = metadata;
}
