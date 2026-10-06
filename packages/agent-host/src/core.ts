import { randomUUID } from 'node:crypto';
import { resolvePermissionDecision } from '@brainstrike/assistant-contract';
import type { LogRow, StateStore } from '@brainstrike/state-store';
import { stepCountIs, streamText, type ToolSet, tool } from 'ai';
import { z } from 'zod';
import type { HostPlatform } from './ports.js';
import { type HostEvent, HostEventSchema, type HostLogRow, type HostParams } from './protocol.js';

type Json = z.infer<ReturnType<typeof z.json>>;
type Action = Extract<HostEvent, { type: 'effect.started' }>;
type Interaction = Extract<HostEvent, { type: 'interaction.requested' }>;
interface PendingInteraction {
  readonly event: Interaction;
  readonly reply: ReturnType<typeof Promise.withResolvers<boolean>>;
}
interface Run {
  readonly controller: AbortController;
  readonly effects: Set<Promise<unknown>>;
  readonly id: string;
  pending?: PendingInteraction | undefined;
  readonly permits: Map<string, Action>;
  release?: (() => void) | undefined;
  task?: Promise<void>;
  terminal: boolean;
  readonly threadId: string;
}
interface AcceptedCommand {
  readonly method: string;
  readonly payload: string;
  readonly result: Json;
}

export function jsonValue(value: unknown): Json {
  return z.json().parse(JSON.parse(JSON.stringify(value)));
}
function canonical(value: Json): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
export function hostRow(row: LogRow): HostLogRow {
  const { seq: _storedSeq, ...event } = row.event;
  return { event: HostEventSchema.parse(event), seq: row.seq, threadId: row.threadId };
}

/** One writer, one admission queue, and one SDK loop per root run (ADR-0011/12/17). */
export class HostCore {
  private readonly commands = new Map<string, AcceptedCommand>();
  private readonly threads = new Set<string>();
  private readonly runs = new Map<string, Run>();
  private readonly listeners = new Set<(row: HostLogRow) => void>();
  private admission: Promise<void> = Promise.resolve();
  private closing = false;

  private constructor(
    readonly store: StateStore,
    private readonly platform: HostPlatform,
    private readonly retainRun: () => () => void
  ) {}

  static async open(
    store: StateStore,
    platform: HostPlatform,
    retainRun: () => () => void
  ): Promise<HostCore> {
    const core = new HostCore(store, platform, retainRun);
    for (const threadId of await store.threads()) {
      core.threads.add(threadId);
      for (const row of await store.read(threadId)) {
        core.fold(hostRow(row));
      }
    }
    // A persisted unanswered top-level decision can be answered once after restart.
    // Other interrupted loops and uncertain effects are never replayed.
    for (const run of core.runs.values()) {
      if (run.terminal) {
        continue;
      }
      if (run.pending) {
        run.release = retainRun();
      } else {
        await core.finish(
          run,
          'interrupted',
          'Host restarted; external effect outcomes are not replayed'
        );
      }
    }
    return core;
  }

  private fold(row: HostLogRow): void {
    const event = row.event;
    if (event.type === 'command.accepted') {
      this.commands.set(event.commandId, {
        method: event.method,
        payload: canonical(event.payload),
        result: event.result,
      });
    } else if (event.type === 'run.started') {
      this.runs.set(event.runId, {
        controller: new AbortController(),
        effects: new Set(),
        id: event.runId,
        permits: new Map(),
        terminal: false,
        threadId: row.threadId,
      });
    } else if (event.type === 'interaction.requested') {
      const run = this.runs.get(event.runId);
      if (!run) {
        throw new Error('Interaction references an unknown run');
      }
      const reply = Promise.withResolvers<boolean>();
      reply.promise.catch(() => undefined);
      run.pending = { event, reply };
    } else if (event.type === 'interaction.responded') {
      const run = this.runs.get(event.runId);
      if (run) {
        run.pending = undefined;
      }
    } else if (event.type === 'run.finished') {
      const run = this.runs.get(event.runId);
      if (run) {
        run.terminal = true;
      }
    }
  }

  private async append(threadId: string, events: readonly HostEvent[]): Promise<HostLogRow[]> {
    const rows = (await this.store.append(events.map((event) => ({ event, threadId })))).map(
      hostRow
    );
    for (const row of rows) {
      for (const listener of this.listeners) {
        listener(row);
      }
    }
    return rows;
  }

  onCommitted(listener: (row: HostLogRow) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async read(threadId: string, fromSeq: number): Promise<HostLogRow[]> {
    if (!this.threads.has(threadId)) {
      throw new Error('Unknown thread');
    }
    return (await this.store.read(threadId, fromSeq + 1)).map(hostRow);
  }

  private command<T extends Json>(
    method: string,
    params: { commandId: string },
    perform: () => Promise<T>
  ): Promise<T> {
    const result = this.admission.then(async () => {
      if (this.closing) {
        throw new Error('Host is closing');
      }
      const payload = canonical(jsonValue(params));
      const previous = this.commands.get(params.commandId);
      if (previous) {
        if (previous.method !== method || previous.payload !== payload) {
          throw new Error('Command identity was reused with different input');
        }
        return previous.result as T;
      }
      return perform();
    });
    this.admission = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async accept(
    threadId: string,
    method: string,
    params: { commandId: string },
    result: Json,
    events: readonly HostEvent[]
  ): Promise<void> {
    const accepted: HostEvent = {
      commandId: params.commandId,
      method,
      payload: jsonValue(params),
      result,
      type: 'command.accepted',
    };
    await this.append(threadId, [accepted, ...events]);
    this.commands.set(params.commandId, { method, payload: canonical(accepted.payload), result });
  }

  startThread(params: HostParams<'thread/start'>): Promise<{ threadId: string }> {
    return this.command('thread/start', params, async () => {
      const result = { threadId: randomUUID() };
      await this.accept(result.threadId, 'thread/start', params, result, [
        { commandId: params.commandId, type: 'thread.started' },
      ]);
      this.threads.add(result.threadId);
      return result;
    });
  }

  startRun(params: HostParams<'run/start'>): Promise<{ runId: string }> {
    return this.command('run/start', params, async () => {
      if (!this.threads.has(params.threadId)) {
        throw new Error('Unknown thread');
      }
      for (const active of this.runs.values()) {
        if (active.threadId === params.threadId && !active.terminal) {
          throw new Error('Thread already has an active root run');
        }
      }
      const model = await this.platform.resolveModel(params.modelId);
      const release = this.retainRun();
      const run: Run = {
        controller: new AbortController(),
        effects: new Set(),
        id: randomUUID(),
        permits: new Map(),
        release,
        terminal: false,
        threadId: params.threadId,
      };
      const result = { runId: run.id };
      try {
        await this.accept(params.threadId, 'run/start', params, result, [
          { modelId: params.modelId, prompt: params.prompt, runId: run.id, type: 'run.started' },
        ]);
      } catch (cause) {
        release();
        throw cause;
      }
      this.runs.set(run.id, run);
      run.task = this.loop(run, model, params.prompt);
      // Stop/close joins this task; retain failures rather than leaking rejections.
      run.task.catch(() => undefined);
      return result;
    });
  }

  private decision(toolId: string): 'allow' | 'ask' | 'deny' {
    const registered = this.platform.tools[toolId];
    if (!registered) {
      throw new Error('Tool is not registered');
    }
    const snapshot = this.platform.readPermissionPolicy();
    // ADR-0010: explicit deny outranks a session grant or YOLO.
    if (
      snapshot.perToolOverrides?.[toolId] === 'deny' ||
      snapshot.policies[registered.risk] === 'deny'
    ) {
      return 'deny';
    }
    return resolvePermissionDecision({
      policies: snapshot.policies,
      riskCategory: registered.risk,
      toolId,
      ...(snapshot.perToolOverrides ? { perToolOverrides: snapshot.perToolOverrides } : {}),
      sessionGrants: new Set(snapshot.sessionGrants ?? []),
      yolo: snapshot.yolo,
    });
  }

  private async approve(run: Run, action: Action): Promise<boolean> {
    run.controller.signal.throwIfAborted();
    const decision = this.decision(action.toolId);
    if (decision === 'deny') {
      return false;
    }
    if (decision === 'ask') {
      const event: Interaction = {
        ...action,
        interactionId: randomUUID(),
        kind: 'approval',
        type: 'interaction.requested',
      };
      const reply = Promise.withResolvers<boolean>();
      reply.promise.catch(() => undefined);
      if (run.pending) {
        throw new Error('A run cannot own two simultaneous approval decisions');
      }
      run.pending = { event, reply };
      await this.append(run.threadId, [event]);
      const approved = await reply.promise;
      if (!approved) {
        return false;
      }
    }
    run.controller.signal.throwIfAborted();
    run.permits.set(action.toolCallId, action);
    return true;
  }

  private async execute(run: Run, action: Action): Promise<unknown> {
    const registered = this.platform.tools[action.toolId];
    const permitted = run.permits.get(action.toolCallId);
    if (!registered || registered.identity !== action.toolIdentity || permitted !== action) {
      throw new Error('Tool execution lacks its exact host permission decision');
    }
    run.permits.delete(action.toolCallId);
    run.controller.signal.throwIfAborted();
    if (this.decision(action.toolId) === 'deny') {
      throw new Error('Tool permission was revoked');
    }
    const input = registered.inputSchema.parse(action.input);
    await this.append(run.threadId, [action]);
    run.controller.signal.throwIfAborted();
    const output = await registered.execute(input, {
      runId: run.id,
      signal: run.controller.signal,
      threadId: run.threadId,
      toolCallId: action.toolCallId,
    });
    await this.append(run.threadId, [
      {
        output: jsonValue(output),
        runId: run.id,
        toolCallId: action.toolCallId,
        type: 'effect.finished',
      },
    ]);
    return output;
  }

  private sdkTools(run: Run): ToolSet {
    const tools: ToolSet = {};
    for (const [id, registered] of Object.entries(this.platform.tools)) {
      tools[id] = tool({
        description: registered.description,
        execute: async (_input, options) => {
          const action = run.permits.get(options.toolCallId);
          if (!action || action.toolId !== id) {
            throw new Error('Tool execution bypassed host permission admission');
          }
          const effect = this.execute(run, action);
          run.effects.add(effect);
          const joined = (): void => {
            run.effects.delete(effect);
          };
          effect.then(joined, joined);
          return effect;
        },
        inputSchema: registered.inputSchema,
      });
    }
    return tools;
  }

  private async sdkApproval(
    run: Run,
    call: { toolName: string; toolCallId: string; input: unknown }
  ): Promise<'approved' | 'denied'> {
    const registered = this.platform.tools[call.toolName];
    if (!registered) {
      throw new Error('Unknown tool');
    }
    const action: Action = {
      input: jsonValue(call.input),
      runId: run.id,
      toolCallId: call.toolCallId,
      toolId: call.toolName,
      toolIdentity: registered.identity,
      type: 'effect.started',
    };
    return (await this.approve(run, action)) ? 'approved' : 'denied';
  }

  private async loop(
    run: Run,
    model: Awaited<ReturnType<HostPlatform['resolveModel']>>,
    prompt: string
  ): Promise<void> {
    let failed: string | undefined;
    try {
      const result = streamText({
        abortSignal: run.controller.signal,
        maxRetries: 0,
        model,
        prompt,
        stopWhen: stepCountIs(this.platform.maxSteps),
        toolApproval: ({ toolCall }) => this.sdkApproval(run, toolCall),
        tools: this.sdkTools(run),
      });
      for await (const chunk of result.fullStream) {
        if (chunk.type === 'error') {
          failed = chunk.error instanceof Error ? chunk.error.message : String(chunk.error);
        }
        await this.append(run.threadId, [
          { chunk: jsonValue(chunk), runId: run.id, type: 'stream.chunk' },
        ]);
        if (chunk.type === 'finish-step') {
          await this.store.syncBoundary(run.threadId);
        }
      }
    } catch (cause) {
      failed = cause instanceof Error ? cause.message : String(cause);
    }
    await this.finishLoop(run, failed);
  }

  private async finishLoop(run: Run, failed: string | undefined): Promise<void> {
    if (this.closing && run.pending) {
      await Promise.allSettled([...run.effects]);
      run.release?.();
      run.release = undefined;
      return;
    }
    const outcome = run.controller.signal.aborted
      ? this.closing
        ? 'interrupted'
        : 'stopped'
      : failed
        ? 'failed'
        : 'completed';
    await this.finish(run, outcome, failed);
  }

  private run(threadId: string, runId: string): Run {
    const run = this.runs.get(runId);
    if (!run || run.threadId !== threadId) {
      throw new Error('Unknown run for this thread');
    }
    return run;
  }

  respond(params: HostParams<'interaction/respond'>): Promise<{ accepted: true }> {
    return this.command('interaction/respond', params, async () => {
      const run = this.run(params.threadId, params.runId);
      const pending = run.pending;
      if (run.terminal || !pending || pending.event.interactionId !== params.interactionId) {
        throw new Error('Approval decision is stale or belongs to another run');
      }
      const registered = this.platform.tools[pending.event.toolId];
      if (!registered || registered.identity !== pending.event.toolIdentity) {
        throw new Error('Approval tool identity changed');
      }
      const result = { accepted: true as const };
      await this.accept(run.threadId, 'interaction/respond', params, result, [
        {
          decision: params.decision,
          interactionId: params.interactionId,
          runId: run.id,
          type: 'interaction.responded',
        },
      ]);
      run.pending = undefined;
      if (run.task) {
        pending.reply.resolve(params.decision === 'approve');
      } else {
        // Restart resumes only the unanswered effect, never uncertain completed work.
        run.task = this.resumeDecision(run, pending.event, params.decision === 'approve');
        run.task.catch(() => undefined);
      }
      return result;
    });
  }

  private async resumeDecision(run: Run, pending: Interaction, approved: boolean): Promise<void> {
    try {
      if (approved) {
        const action: Action = { ...pending, type: 'effect.started' };
        // Strip interaction-only fields before persisting the effect schema.
        const clean = HostEventSchema.parse({
          input: action.input,
          runId: action.runId,
          toolCallId: action.toolCallId,
          toolId: action.toolId,
          toolIdentity: action.toolIdentity,
          type: action.type,
        }) as Action;
        run.permits.set(clean.toolCallId, clean);
        await this.execute(run, clean);
      }
      await this.finish(
        run,
        'interrupted',
        'Pending decision completed; model continuation requires an explicit new run'
      );
    } catch (cause) {
      await this.finish(
        run,
        run.controller.signal.aborted ? 'stopped' : 'failed',
        cause instanceof Error ? cause.message : String(cause)
      );
    }
  }

  stop(params: HostParams<'run/stop'>): Promise<{ outcome: 'stopped' | 'already-terminal' }> {
    return this.command('run/stop', params, async () => {
      const run = this.run(params.threadId, params.runId);
      const result = {
        outcome: run.terminal ? ('already-terminal' as const) : ('stopped' as const),
      };
      await this.accept(run.threadId, 'run/stop', params, result, []);
      if (!run.terminal) {
        run.controller.abort(new Error('Run stopped by user'));
        run.pending?.reply.reject(run.controller.signal.reason);
        if (run.task) {
          await run.task;
        } else {
          await this.finish(run, 'stopped');
        }
      }
      return result;
    });
  }

  private async finish(
    run: Run,
    outcome: Extract<HostEvent, { type: 'run.finished' }>['outcome'],
    detail?: string
  ): Promise<void> {
    if (run.terminal) {
      return;
    }
    try {
      // SDK abort can end its stream before a tool's physical process exits.
      // Only the host owns terminal admission, so join all dispatched work first.
      await Promise.allSettled([...run.effects]);
      await this.append(run.threadId, [
        { outcome, runId: run.id, type: 'run.finished', ...(detail ? { detail } : {}) },
      ]);
      await this.store.syncBoundary(run.threadId);
      run.terminal = true;
    } finally {
      run.release?.();
      run.release = undefined;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.admission;
    for (const run of this.runs.values()) {
      if (!run.terminal) {
        run.controller.abort(new Error('Host is closing'));
        run.pending?.reply.reject(run.controller.signal.reason);
      }
    }
    await Promise.all(
      [...this.runs.values()].map(async (run) => {
        if (run.task) {
          await run.task;
        } else if (run.terminal || run.pending) {
          run.release?.();
          run.release = undefined;
        } else {
          await this.finish(run, 'interrupted', 'Host closed with a pending decision');
        }
      })
    );
    await this.platform.close();
    this.listeners.clear();
  }
}
