import type { HostClient } from '@brainstrike/agent-host/browser';
import type { HostLogRow, HostParams, HostResults } from '@brainstrike/agent-host/protocol';
import type { CommittedThreadSession } from '@brainstrike/agent-host/thread-view';
import {
  type McpElicitationPresentationWire,
  type McpElicitationSettlement,
  parseMcpElicitationPresentation,
  parseMcpElicitationSettlement,
} from '@brainstrike/assistant-contract';

type InputRead = HostResults['mcp/input/read'];
type InputRequest = InputRead['request'];
type InputStatus = InputRead['status'];
type Address = HostParams<'mcp/input/read'>;
interface InputPhase {
  readonly request: InputRequest;
  status: InputStatus;
}

export interface CommittedMcpInputSnapshot {
  readonly connected: boolean;
  readonly error?: string;
  readonly input?: {
    readonly address: Address;
    readonly presentation?: McpElicitationPresentationWire;
    readonly request: InputRequest;
    readonly status: InputStatus;
  };
}

function unavailable(): Error {
  return new Error('The agent host MCP input is unavailable or stale.');
}

function matches(request: InputRequest, presentation: McpElicitationPresentationWire): boolean {
  const origin = presentation.provenance;
  return (
    presentation.id === request.interactionId &&
    presentation.mode === request.mode &&
    origin.configuredServerId === request.configuredServerId &&
    origin.generation === request.generation &&
    origin.invocationId === request.invocationId &&
    origin.requestId === request.requestId &&
    origin.taskHandle?.taskId === request.taskId
  );
}

function retireRunInputs(inputs: Map<string, InputPhase>, runId: string): void {
  for (const input of inputs.values()) {
    if (input.request.runId !== runId) {
      continue;
    }
    if (input.status === 'requested') {
      input.status = 'retired';
    } else if (input.status === 'accepted') {
      input.status = 'unknown';
    }
  }
}

function foldInputs(rows: readonly HostLogRow[]): Map<string, InputPhase> {
  const inputs = new Map<string, InputPhase>();
  for (const row of rows) {
    const event = row.event;
    if (event.type === 'mcp.input.requested') {
      inputs.set(event.interactionId, { request: event, status: 'requested' });
    } else if (event.type === 'mcp.input.intent' || event.type === 'mcp.input.settled') {
      const input = inputs.get(event.interactionId);
      if (input) {
        input.status = event.type === 'mcp.input.intent' ? 'accepted' : event.status;
      }
    } else if (event.type === 'run.finished') {
      retireRunInputs(inputs, event.runId);
    }
  }
  return inputs;
}

/** Passive committed request view; private presentation and values remain process-local. */
export class CommittedHostMcpInput {
  private readonly listeners = new Set<() => void>();
  private readonly dismissed = new Set<string>();
  private readonly attempts = new Map<
    string,
    {
      readonly action: McpElicitationSettlement['action'];
      readonly task: Promise<void>;
      uncertain: boolean;
    }
  >();
  private readonly release: () => void;
  private snapshot: CommittedMcpInputSnapshot = { connected: true };
  private selection = '';
  private epoch = 0;
  private closed = false;

  constructor(
    private readonly client: HostClient,
    private readonly source: CommittedThreadSession,
    private readonly threadId: string
  ) {
    this.release = source.subscribe(() => this.refresh());
    this.refresh();
  }

  readonly getSnapshot = (): CommittedMcpInputSnapshot => this.snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(snapshot: CommittedMcpInputSnapshot): void {
    if (this.closed) {
      return;
    }
    this.snapshot = snapshot;
    for (const listener of this.listeners) {
      listener();
    }
  }

  private refresh(): void {
    if (this.closed) {
      return;
    }
    const source = this.source.getSnapshot();
    const inputs = foldInputs(source.rows);
    const current = [...inputs.values()].find(
      ({ request, status }) =>
        !this.dismissed.has(request.interactionId) &&
        status !== 'local-finalized' &&
        status !== 'remote-acknowledged'
    );
    const connected = source.connected && source.error === undefined;
    const selection = JSON.stringify([connected, current?.request.interactionId, current?.status]);
    if (selection === this.selection) {
      return;
    }
    this.selection = selection;
    const epoch = ++this.epoch;
    if (!current) {
      this.publish({ connected });
      return;
    }
    const address: Address = {
      interactionId: current.request.interactionId,
      runId: current.request.runId,
      threadId: this.threadId,
    };
    const uncertain = this.attempts.get(address.interactionId)?.uncertain === true;
    this.publish({
      connected,
      input: { address, ...current, ...(uncertain ? { status: 'unknown' } : {}) },
    });
    if (!connected || uncertain) {
      return;
    }
    this.readPresentation(address, current.request, connected, epoch);
  }

  private readPresentation(
    address: Address,
    request: InputRequest,
    connected: boolean,
    epoch: number
  ): void {
    // This is a read of the current private capability, never a reconstruction
    // from committed request metadata or an automatic delivery retry.
    void this.client.request('mcp/input/read', address).then(
      (input) => {
        if (this.closed || epoch !== this.epoch) {
          return;
        }
        try {
          const presentation =
            input.presentation === undefined
              ? undefined
              : parseMcpElicitationPresentation(input.presentation);
          if (presentation && !matches(request, presentation)) {
            throw unavailable();
          }
          this.publish({
            connected,
            input: {
              address,
              request,
              status: input.status,
              ...(input.status === 'requested' && presentation ? { presentation } : {}),
            },
          });
        } catch {
          this.publish({ connected, error: unavailable().message });
        }
      },
      () => {
        if (!this.closed && epoch === this.epoch) {
          this.publish({ connected, error: unavailable().message });
        }
      }
    );
  }

  settle(input: McpElicitationSettlement): Promise<void> {
    const answer = parseMcpElicitationSettlement(input);
    const pending = this.snapshot.input;
    if (
      !(this.snapshot.connected && pending?.presentation) ||
      pending.status !== 'requested' ||
      answer.id !== pending.request.interactionId ||
      answer.configuredServerId !== pending.request.configuredServerId ||
      answer.generation !== pending.request.generation ||
      answer.requestId !== pending.request.requestId
    ) {
      return Promise.reject(unavailable());
    }
    const existing = this.attempts.get(answer.id);
    if (existing) {
      return existing.action === answer.action ? existing.task : Promise.reject(unavailable());
    }
    let dispatched = false;
    const task = Promise.resolve().then(async () => {
      try {
        if (answer.action === 'accept') {
          await this.client.request('mcp/input/stage', {
            ...pending.address,
            ...(answer.content === undefined ? {} : { content: answer.content }),
          });
        }
        dispatched = true;
        await this.client.request('mcp/input/settle', {
          ...pending.address,
          action: answer.action,
          commandId: crypto.randomUUID(),
        });
      } catch {
        if (dispatched) {
          // Response loss cannot authorize another send. Only subsequent Core
          // facts can establish its outcome; never reuse a legacy settlement.
          const attempt = this.attempts.get(answer.id);
          if (attempt) {
            attempt.uncertain = true;
          }
          this.selection = '';
          this.refresh();
        } else {
          this.attempts.delete(answer.id);
        }
        throw unavailable();
      }
    });
    this.attempts.set(answer.id, { action: answer.action, task, uncertain: false });
    return task;
  }

  dismiss(): void {
    const input = this.snapshot.input;
    if (input && input.status !== 'requested') {
      this.dismissed.add(input.address.interactionId);
      this.selection = '';
      this.refresh();
    }
  }

  close(): void {
    this.closed = true;
    this.epoch += 1;
    this.release();
    this.listeners.clear();
    this.attempts.clear();
    this.snapshot = { connected: false };
  }
}
