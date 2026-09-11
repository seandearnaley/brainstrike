import { isDeepStrictEqual } from 'node:util';
import type { MastraDBMessage } from '@mastra/core/agent';
import type {
  BackgroundTask,
  BackgroundTaskManager,
  ResultInjector,
} from '@mastra/core/background-tasks';
import type { MastraMemory } from '@mastra/core/memory';
import type { RuntimeData } from '../types';
import {
  completedBackgroundOutcome,
  requireBackgroundResultDelivery,
} from './background-result-delivery';

type Outcome = Pick<Parameters<ResultInjector>[0], 'status' | 'result' | 'error'>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function invocation(message: MastraDBMessage, task: BackgroundTask) {
  const metadata = record(message.content.metadata?.['backgroundTasks']);
  if (record(metadata?.[task.toolCallId])?.['taskId'] !== task.id) {
    throw new Error('Background result does not match its native parent invocation.');
  }
  const part = message.content.parts.find(
    (candidate) =>
      candidate.type === 'tool-invocation' &&
      candidate.toolInvocation.toolCallId === task.toolCallId
  );
  if (part?.type !== 'tool-invocation') {
    throw new Error('Background parent invocation is missing.');
  }
  return part;
}

function applyOutcome(message: MastraDBMessage, task: BackgroundTask, outcome: Outcome): void {
  const part = invocation(message, task);
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
    mastra: { ...record(part.providerMetadata?.['mastra']), modelOutput: null },
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

function indexInvocations(messages: MastraDBMessage[]): Map<string, MastraDBMessage[]> {
  const indexed = new Map<string, MastraDBMessage[]>();
  for (const message of messages) {
    const tasks = record(message.content.metadata?.['backgroundTasks']);
    for (const value of Object.values(tasks ?? {})) {
      const taskId = record(value)?.['taskId'];
      // Only a metadata entry naming this durable task is an invocation join.
      if (typeof taskId !== 'string') {
        continue;
      }
      const matches = indexed.get(taskId) ?? [];
      matches.push(message);
      indexed.set(taskId, matches);
    }
  }
  return indexed;
}

function requireInvocation(
  indexed: Map<string, MastraDBMessage[]>,
  task: BackgroundTask
): MastraDBMessage {
  const matches = indexed.get(task.id);
  if (matches?.length !== 1 || !matches[0]) {
    throw new Error('Background result has no unique native parent invocation.');
  }
  return matches[0];
}

/** Result and cleared decision metadata are saved in the same native message write. */
export async function saveBackgroundResult(
  memory: MastraMemory,
  task: BackgroundTask,
  outcome: Outcome
): Promise<void> {
  if (!(task.threadId && task.resourceId)) {
    throw new Error('Background result has no root memory owner.');
  }
  const { messages } = await memory.recall({
    perPage: false,
    resourceId: task.resourceId,
    threadId: task.threadId,
  });
  const indexed = indexInvocations(messages);
  const message = structuredClone(
    indexed.has(task.id) ? requireInvocation(indexed, task) : recoveredInvocation(task)
  );
  applyOutcome(message, task, outcome);
  await memory.saveMessages({ messages: [message] });
}

function outcomeIsSaved(message: MastraDBMessage, task: BackgroundTask): boolean {
  const call = invocation(message, task).toolInvocation;
  return task.status === 'completed'
    ? call.state === 'result' && isDeepStrictEqual(call.result, task.result)
    : call.state === 'output-error' && call.errorText === task.error?.message;
}

function recoveredInvocation(task: BackgroundTask): MastraDBMessage {
  if (!(task.threadId && task.resourceId)) {
    throw new Error('Recovered background result has no owner.');
  }
  return {
    content: {
      format: 2,
      metadata: { backgroundTasks: { [task.toolCallId]: { taskId: task.id } } },
      parts: [
        {
          text: 'Recovered a finished background task whose original message is no longer available. This reports its saved outcome; the work was not executed again.',
          type: 'text',
        },
        {
          toolInvocation: {
            args: task.args,
            state: 'call',
            toolCallId: task.toolCallId,
            toolName: task.toolName,
          },
          type: 'tool-invocation',
        },
      ],
    },
    createdAt: task.completedAt ?? task.createdAt,
    id: `background-result-${task.id}`,
    resourceId: task.resourceId,
    role: 'assistant',
    threadId: task.threadId,
  };
}

/** Repair completed-but-undelivered results before inference; never dispatch task executors. */
export async function repairBackgroundResults(params: {
  readonly manager: BackgroundTaskManager | undefined;
  readonly memory: MastraMemory | undefined;
  readonly scope: RuntimeData['memory'];
}): Promise<string[]> {
  const { manager, memory, scope } = params;
  if (!manager) {
    return [];
  }
  if (!(memory && scope)) {
    throw new Error('Background recovery requires the original root memory owner.');
  }
  const delivery = requireBackgroundResultDelivery(await manager.getStorage());
  const listPage = (page: number) =>
    delivery.listUndeliveredTasks({
      orderBy: 'createdAt',
      orderDirection: 'asc',
      page,
      perPage: 100,
      resourceId: scope.resourceId,
      status: ['completed', 'failed', 'timed_out'],
      threadId: scope.threadId,
    });
  const first = await listPage(0);
  if (first.total === 0) {
    return [];
  }
  const { messages } = await memory.recall({
    perPage: false,
    resourceId: scope.resourceId,
    threadId: scope.threadId,
  });
  const indexed = indexInvocations(messages);
  const changed = new Map<string, MastraDBMessage>();
  const repaired: string[] = [];
  const delivered: string[] = [];
  let page = 0;
  let total: number;
  do {
    const result = page === 0 ? first : await listPage(page);
    total = result.total;
    for (const task of result.tasks) {
      const outcome = completedBackgroundOutcome(task);
      const original = indexed.has(task.id)
        ? requireInvocation(indexed, task)
        : recoveredInvocation(task);
      delivered.push(task.id);
      const message = changed.get(original.id) ?? structuredClone(original);
      if (outcomeIsSaved(message, task)) {
        continue;
      }
      applyOutcome(message, task, outcome);
      changed.set(message.id, message);
      repaired.push(task.id);
    }
    page += 1;
  } while (page * 100 < total);
  if (changed.size > 0) {
    await memory.saveMessages({ messages: [...changed.values()] });
  }
  for (const taskId of delivered) {
    await delivery.markResultDelivered(taskId);
  }
  return repaired;
}
