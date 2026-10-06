import type { ModelMessage } from 'ai';
import { recordRawToolInputs } from './approval-input.js';
import { canonical, type Json, jsonValue } from './json-value.js';
import type { HostRunContext, HostRunOwner } from './ports.js';
import { HOST_METHOD_SCHEMAS, type HostEvent } from './protocol.js';

/** HostCore alone folds and writes accepted command records. */
export interface AcceptedCommand {
  readonly method: string;
  readonly payload: string;
  readonly result: Json;
}

/** Process-local attempts retain uncertainty; restart uses only committed records. */
export interface AttemptedCommand {
  readonly method: string;
  readonly payload: string;
  readonly settlement: Promise<Json>;
}

/** Owned exclusively by HostCore, with no independent writer or admission queue. */
export class HostCommandLedger {
  private readonly accepted = new Map<string, AcceptedCommand>();
  private readonly attempts = new Map<string, AttemptedCommand>();

  commit(commandId: string, command: AcceptedCommand): void {
    this.accepted.set(commandId, command);
  }

  async perform<T extends Json>(
    method: string,
    params: { commandId: string },
    perform: () => Promise<T>,
    repeat?: (result: T) => Promise<T>
  ): Promise<T> {
    const payload = canonical(jsonValue(params));
    const attempt = this.attempts.get(params.commandId);
    const previous = attempt ?? this.accepted.get(params.commandId);
    if (previous && (previous.method !== method || previous.payload !== payload)) {
      throw new Error('Command identity was reused with different input');
    }
    if (attempt) {
      // Includes physical joining and preserves rejection after a genuine commit.
      return (await attempt.settlement) as T;
    }
    const committed = this.accepted.get(params.commandId);
    if (committed) {
      return repeat ? repeat(committed.result as T) : (committed.result as T);
    }
    const settlement = Promise.withResolvers<Json>();
    settlement.promise.catch(() => undefined);
    this.attempts.set(params.commandId, { method, payload, settlement: settlement.promise });
    try {
      const value = await perform();
      settlement.resolve(value);
      return value;
    } catch (cause) {
      settlement.reject(cause);
      throw cause;
    }
  }
}

type Action = Extract<HostEvent, { type: 'effect.started' }>;
type Interaction = Extract<HostEvent, { type: 'interaction.requested' }>;
export interface PendingInteraction {
  decision?: 'approve' | 'deny';
  readonly event: Interaction;
  runtimeInput?: { readonly value: unknown };
}
export interface HostRunState {
  readonly approvals: Map<string, PendingInteraction>;
  readonly checkpointedResults: Set<string>;
  completion?: Promise<void>;
  readonly controller: AbortController;
  readonly effects: Set<Promise<unknown>>;
  readonly id: string;
  readonly liveInputs: Map<string, { readonly value: unknown }>;
  readonly messageIndexes: Set<number>;
  readonly modelId: string;
  outcome?: Extract<HostEvent, { type: 'run.finished' }>['outcome'];
  readonly outputs: Map<string, Json>;
  owner?: Promise<HostRunOwner | undefined>;
  ownerClose?: Promise<void>;
  paused: boolean;
  readonly permits: Map<string, Action>;
  readonly rawInputs: Map<string, Json>;
  release?: (() => void) | undefined;
  readonly responses: Set<string>;
  readonly started: Set<string>;
  steps: number;
  stopAcceptance?: Promise<void> | undefined;
  stopped: boolean;
  task?: Promise<void>;
  terminal: boolean;
  readonly threadId: string;
}

export function createHostRunState(threadId: string, id: string, modelId: string): HostRunState {
  return {
    approvals: new Map(),
    checkpointedResults: new Set(),
    controller: new AbortController(),
    effects: new Set(),
    id,
    liveInputs: new Map(),
    messageIndexes: new Set(),
    modelId,
    outputs: new Map(),
    paused: false,
    permits: new Map(),
    rawInputs: new Map(),
    responses: new Set(),
    started: new Set(),
    steps: 0,
    stopped: false,
    terminal: false,
    threadId,
  };
}

export function foldHostAcceptedCommand(
  commands: HostCommandLedger,
  runs: ReadonlyMap<string, HostRunState>,
  event: Extract<HostEvent, { type: 'command.accepted' }>
): void {
  commands.commit(event.commandId, {
    method: event.method,
    payload: canonical(event.payload),
    result: event.result,
  });
  if (event.method !== 'run/stop') {
    return;
  }
  const params = HOST_METHOD_SCHEMAS['run/stop'].parse(event.payload);
  const run = runs.get(params.runId);
  if (run) {
    run.stopped = true;
  }
}

/** HostCore supplies already-validated committed messages; no independent fold or writer. */
export function foldHostRunMessages(
  run: HostRunState,
  event: Extract<HostEvent, { type: 'model.step' | 'model.messages' }>,
  messages: readonly ModelMessage[],
  previousLength: number
): void {
  for (let index = 0; index < messages.length; index += 1) {
    run.messageIndexes.add(previousLength + index);
  }
  if (event.type === 'model.step') {
    run.steps = event.stepNumber + 1;
  }
  recordRawToolInputs(run.rawInputs, messages);
  for (const message of messages) {
    if (message.role !== 'tool') {
      continue;
    }
    for (const part of message.content) {
      if (part.type === 'tool-approval-response') {
        run.responses.add(part.approvalId);
      }
      if (part.type === 'tool-result') {
        run.checkpointedResults.add(part.toolCallId);
      }
    }
  }
}

/** Receipts use the caller's existing FULL publisher, with no queue/store of their own. */
export function createHostRunContext(
  run: HostRunState,
  publish: (threadId: string, events: readonly HostEvent[]) => Promise<unknown>
): HostRunContext {
  return {
    recordObserverUsage: async (receipt) => {
      if (run.terminal) {
        throw new Error('Memory receipt arrived after the run lifetime joined');
      }
      await publish(run.threadId, [
        {
          kind: receipt.kind,
          modelId: receipt.modelId,
          runId: run.id,
          type: 'memory.usage',
          usage: jsonValue(receipt.usage),
        },
      ]);
    },
    recordProviderRequest: async (receipt) => {
      if (run.terminal) {
        throw new Error('Provider receipt arrived after the run lifetime joined');
      }
      await publish(run.threadId, [
        {
          accounting: jsonValue(receipt.accounting),
          modelId: receipt.modelId,
          provider: receipt.provider,
          runId: run.id,
          type: 'provider.request.prepared',
        },
      ]);
    },
    runId: run.id,
    signal: run.controller.signal,
    threadId: run.threadId,
  };
}
