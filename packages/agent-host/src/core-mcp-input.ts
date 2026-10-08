import {
  type McpElicitationPresentationWire,
  McpElicitationPresentationWireSchema,
  type McpElicitationRetiredWire,
  parseMcpElicitationSettlement,
} from '@brainstrike/assistant-contract';
import type { HostRunState } from './core-state.js';
import { type HostMcpInputPort, type HostMcpInputSink, HostMcpInputUnboundError } from './ports.js';
import type { HostEvent, HostParams } from './protocol.js';

/** The exact run log position of one MCP input: the tool call that raised it. */
export interface HostMcpInputBinding {
  readonly runId: string;
  readonly threadId: string;
  readonly toolCallId: string;
}

interface PendingInput extends HostMcpInputBinding {
  readonly committed: Promise<void>;
}

/** HostCore's capabilities; this ledger owns no writer, queue or store of its own. */
export interface HostMcpInputCore {
  /** HostCore's sole writer: commits, then publishes to clients. */
  append(threadId: string, events: readonly HostEvent[]): Promise<unknown>;
  closing(): boolean;
  /** Whether the thread's log is being erased (no further commits). */
  deleting(threadId: string): boolean;
  runs(): ReadonlyMap<string, HostRunState>;
}

type InputEvent = Extract<HostEvent, { type: 'input.requested' | 'input.retired' }>;

/**
 * Binds MCP server input to the host tool call named by its provenance caller
 * and commits it through HostCore before any client can display it. Input
 * with no caller, or whose caller is not an admitted execution of that run,
 * is refused: nothing is inferred from in-flight calls.
 */
export class HostMcpInputLedger {
  /** Input committed by this process whose retirement is still owed. */
  private readonly pending = new Map<string, PendingInput>();
  /** Requested by an earlier process and never retired (it ended uncleanly). */
  private readonly stale = new Map<string, HostMcpInputBinding>();
  private readonly work = new Set<{ readonly promise: Promise<void>; readonly threadId: string }>();
  private readonly failures: unknown[] = [];
  private detach: (() => void) | undefined;
  private port: HostMcpInputPort | undefined;

  constructor(private readonly core: HostMcpInputCore) {}

  readonly sink: HostMcpInputSink = {
    present: (presentation) => this.present(presentation),
    retire: (retired) => this.retire(retired),
  };

  /** Hydration only: this process's own commits update the ledger directly. */
  fold(threadId: string, event: InputEvent): void {
    if (event.type === 'input.requested') {
      this.stale.set(event.inputId, {
        runId: event.runId,
        threadId,
        toolCallId: event.toolCallId,
      });
    } else {
      this.stale.delete(event.inputId);
    }
  }

  /**
   * After hydration: retire what an earlier process left pending, then become
   * the presenter's single consent surface for host-run input.
   */
  async open(port: HostMcpInputPort | undefined): Promise<void> {
    await this.retireStale();
    this.port = port;
    this.detach = port?.attach(this.sink);
  }

  /**
   * Routes a client's answer to committed input to the presenter, the only
   * settlement writer and idempotency authority. Nothing is committed here:
   * the presenter's finalization becomes `input.retired`, and the form content
   * never enters the log (ADR-0010).
   */
  async settle(params: HostParams<'input/settle'>): Promise<{ accepted: true }> {
    if (this.core.closing() || this.core.deleting(params.threadId)) {
      throw new Error('MCP input settlement is closed for this thread');
    }
    const settlement = parseMcpElicitationSettlement(params.settlement);
    const pending = this.pendingInput(params, settlement.id);
    if (!this.port) {
      throw new Error('This host has no MCP input authority');
    }
    await pending.committed;
    this.port.settle(settlement);
    return { accepted: true };
  }

  /** Joins every commit, detaches, and returns retirement failures no caller observed. */
  async close(): Promise<readonly unknown[]> {
    await Promise.allSettled([...this.work].map((item) => item.promise));
    this.detach?.();
    this.detach = undefined;
    return [...this.failures];
  }

  /**
   * Presentation IDs are process-local, so input an earlier process left
   * pending can never be answered: record the presenter's closed retirement.
   */
  private async retireStale(): Promise<void> {
    for (const [inputId, binding] of this.stale) {
      await this.core.append(binding.threadId, [
        {
          code: 'mcp-elicitation-presenter-closed',
          inputId,
          runId: binding.runId,
          toolCallId: binding.toolCallId,
          type: 'input.retired',
        },
      ]);
    }
    this.stale.clear();
  }

  /** Committed input a client may answer, checked against the caller's run and call. */
  private pendingInput(binding: HostMcpInputBinding, inputId: string): PendingInput {
    const pending = this.pending.get(inputId);
    if (
      !pending ||
      pending.threadId !== binding.threadId ||
      pending.runId !== binding.runId ||
      pending.toolCallId !== binding.toolCallId
    ) {
      throw new Error('MCP input is not pending for this tool call');
    }
    return pending;
  }

  /** Joins this thread's in-flight commits before its log is erased. */
  async joinThread(threadId: string): Promise<void> {
    await Promise.allSettled(
      [...this.work].filter((item) => item.threadId === threadId).map((item) => item.promise)
    );
  }

  private present(input: McpElicitationPresentationWire): Promise<void> {
    let binding: HostMcpInputBinding;
    let presentation: ReturnType<typeof McpElicitationPresentationWireSchema.parse>;
    try {
      // The committed request is exactly the validated browser-safe wire.
      presentation = McpElicitationPresentationWireSchema.parse(input);
      binding = this.bind(presentation.provenance.caller);
      if (this.pending.has(presentation.id)) {
        throw new HostMcpInputUnboundError('its presentation id is already pending');
      }
    } catch (cause) {
      return Promise.reject(cause);
    }
    // A failed commit rejects to the presenter, which refuses the input.
    const committed = this.retain(
      binding.threadId,
      this.core.append(binding.threadId, [
        {
          inputId: presentation.id,
          presentation,
          runId: binding.runId,
          toolCallId: binding.toolCallId,
          type: 'input.requested',
        },
      ]),
      false
    );
    this.pending.set(presentation.id, { ...binding, committed });
    return committed;
  }

  private retire({ code, id }: McpElicitationRetiredWire): void {
    const pending = this.pending.get(id);
    if (!pending) {
      // Refused before commit, or never this host's input: nothing to retire.
      return;
    }
    this.pending.delete(id);
    const { runId, threadId, toolCallId } = pending;
    void this.retain(
      threadId,
      pending.committed.then(
        async () => {
          if (this.core.deleting(threadId)) {
            return;
          }
          await this.core.append(threadId, [
            { code, inputId: id, runId, toolCallId, type: 'input.retired' },
          ]);
        },
        // The request was never committed, so no client saw it.
        () => undefined
      ),
      true
    );
  }

  private bind(caller: HostMcpInputBinding | undefined): HostMcpInputBinding {
    if (!caller) {
      throw new HostMcpInputUnboundError('it names no host tool call');
    }
    if (this.core.closing()) {
      throw new HostMcpInputUnboundError('the host is closing');
    }
    if (this.core.deleting(caller.threadId)) {
      throw new HostMcpInputUnboundError('its thread is being deleted');
    }
    const run = this.core.runs().get(caller.runId);
    if (!(run && run.threadId === caller.threadId && run.started.has(caller.toolCallId))) {
      throw new HostMcpInputUnboundError('its tool call is not an admitted host execution');
    }
    return { runId: caller.runId, threadId: caller.threadId, toolCallId: caller.toolCallId };
  }

  private retain(threadId: string, operation: Promise<unknown>, report: boolean): Promise<void> {
    const promise = operation.then(() => undefined);
    const item = { promise, threadId };
    this.work.add(item);
    promise.then(
      () => this.work.delete(item),
      (cause: unknown) => {
        this.work.delete(item);
        if (report) {
          this.failures.push(cause);
        }
      }
    );
    return promise;
  }
}
