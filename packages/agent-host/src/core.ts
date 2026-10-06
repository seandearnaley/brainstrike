import { randomUUID } from 'node:crypto';
import { resolvePermissionDecision } from '@brainstrike/assistant-contract';
import type { StateStore } from '@brainstrike/state-store';
import {
  type ModelMessage,
  modelMessageSchema,
  stepCountIs,
  streamText,
  type ToolContent,
  type ToolSet,
  tool,
} from 'ai';
import { z } from 'zod';
import { readHostRow, storedHostEvent } from './event-storage.js';
import type { HostPlatform } from './ports.js';
import {
  HOST_METHOD_SCHEMAS,
  type HostEvent,
  type HostLogRow,
  type HostParams,
} from './protocol.js';

type Json = z.infer<ReturnType<typeof z.json>>;
type Action = Extract<HostEvent, { type: 'effect.started' }>;
type Interaction = Extract<HostEvent, { type: 'interaction.requested' }>;
interface PendingInteraction {
  decision?: 'approve' | 'deny';
  readonly event: Interaction;
}
interface Run {
  readonly approvals: Map<string, PendingInteraction>;
  readonly checkpointedResults: Set<string>;
  readonly controller: AbortController;
  readonly effects: Set<Promise<unknown>>;
  readonly id: string;
  readonly modelId: string;
  readonly outputs: Map<string, Json>;
  paused: boolean;
  readonly permits: Map<string, Action>;
  release?: (() => void) | undefined;
  readonly responses: Set<string>;
  readonly started: Set<string>;
  steps: number;
  stopped: boolean;
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
/** One writer, one admission queue, and one SDK loop per root run (ADR-0011/12/17). */
export class HostCore {
  private readonly commands = new Map<string, AcceptedCommand>();
  private readonly threads = new Set<string>();
  private readonly runs = new Map<string, Run>();
  private readonly messages = new Map<string, ModelMessage[]>();
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
        core.fold(await readHostRow(store, row));
      }
    }
    for (const run of core.runs.values()) {
      if (run.terminal) {
        continue;
      }
      if (run.stopped) {
        await core.finish(run, 'stopped');
        continue;
      }
      const uncertain = [...run.started].some(
        (id) => !(run.outputs.has(id) || run.checkpointedResults.has(id))
      );
      if (uncertain) {
        await core.finish(
          run,
          'interrupted',
          'Host restarted with an uncertain external effect; it was not replayed'
        );
      } else if (run.approvals.size > 0) {
        run.release = retainRun();
        if ([...run.approvals.values()].every((approval) => approval.decision !== undefined)) {
          run.task = core.continueRun(run);
          run.task.catch(() => undefined);
        }
      } else {
        await core.finish(
          run,
          'interrupted',
          'Host restarted outside a committed decision boundary'
        );
      }
    }
    return core;
  }

  private fold(row: HostLogRow): void {
    const event = row.event;
    switch (event.type) {
      case 'command.accepted':
        this.foldCommand(event);
        break;
      case 'run.started':
        this.runs.set(event.runId, this.createRun(row.threadId, event.runId, event.modelId));
        this.messages.set(row.threadId, [
          ...(this.messages.get(row.threadId) ?? []),
          { content: event.prompt, role: 'user' },
        ]);
        break;
      case 'model.step':
      case 'model.messages':
        this.foldMessages(row.threadId, event);
        break;
      case 'interaction.requested': {
        const run = this.runs.get(event.runId);
        if (!run) {
          throw new Error('Interaction references an unknown run');
        }
        run.approvals.set(event.interactionId, { event });
        run.paused = true;
        break;
      }
      case 'interaction.responded': {
        const approval = this.runs.get(event.runId)?.approvals.get(event.interactionId);
        if (approval) {
          approval.decision = event.decision;
        }
        break;
      }
      case 'effect.started':
        this.runs.get(event.runId)?.started.add(event.toolCallId);
        break;
      case 'effect.finished':
        this.runs.get(event.runId)?.outputs.set(event.toolCallId, event.output);
        break;
      case 'run.finished': {
        const run = this.runs.get(event.runId);
        if (run) {
          run.terminal = true;
        }
        break;
      }
      default:
        break;
    }
  }

  private foldCommand(event: Extract<HostEvent, { type: 'command.accepted' }>): void {
    this.commands.set(event.commandId, {
      method: event.method,
      payload: canonical(event.payload),
      result: event.result,
    });
    if (event.method !== 'run/stop') {
      return;
    }
    const params = HOST_METHOD_SCHEMAS['run/stop'].parse(event.payload);
    const run = this.runs.get(params.runId);
    if (run) {
      run.stopped = true;
    }
  }

  private foldMessages(
    threadId: string,
    event: Extract<HostEvent, { type: 'model.step' | 'model.messages' }>
  ): void {
    const messages = event.messages.map((message) => modelMessageSchema.parse(message));
    this.messages.set(threadId, [...(this.messages.get(threadId) ?? []), ...messages]);
    const run = this.runs.get(event.runId);
    if (!run) {
      return;
    }
    if (event.type === 'model.step') {
      run.steps = event.stepNumber + 1;
    }
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

  private createRun(threadId: string, id: string, modelId: string): Run {
    return {
      approvals: new Map(),
      checkpointedResults: new Set(),
      controller: new AbortController(),
      effects: new Set(),
      id,
      modelId,
      outputs: new Map(),
      paused: false,
      permits: new Map(),
      responses: new Set(),
      started: new Set(),
      steps: 0,
      stopped: false,
      terminal: false,
      threadId,
    };
  }

  private async append(threadId: string, events: readonly HostEvent[]): Promise<HostLogRow[]> {
    const committed = await this.store.append(
      events.map((event) => storedHostEvent(threadId, event))
    );
    const rows = await Promise.all(committed.map((row) => readHostRow(this.store, row)));
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
    return Promise.all(
      (await this.store.read(threadId, fromSeq + 1)).map((row) => readHostRow(this.store, row))
    );
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
      const run = this.createRun(params.threadId, randomUUID(), params.modelId);
      run.release = release;
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
      this.messages.set(params.threadId, [
        ...(this.messages.get(params.threadId) ?? []),
        { content: params.prompt, role: 'user' },
      ]);
      run.task = this.loop(run, model);
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
    run.started.add(action.toolCallId);
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
    run.outputs.set(action.toolCallId, jsonValue(output));
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
          return this.dispatch(run, action);
        },
        inputSchema: registered.inputSchema,
      });
    }
    return tools;
  }

  private dispatch(run: Run, action: Action): Promise<unknown> {
    const effect = this.execute(run, action);
    run.effects.add(effect);
    const joined = (): void => {
      run.effects.delete(effect);
    };
    effect.then(joined, joined);
    return effect;
  }

  private sdkApproval(
    run: Run,
    call: { toolName: string; toolCallId: string; input: unknown }
  ): 'approved' | 'denied' | 'user-approval' {
    run.controller.signal.throwIfAborted();
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
    const decision = this.decision(call.toolName);
    const prior = [...run.approvals.values()].find(
      (approval) => approval.event.toolCallId === call.toolCallId
    );
    if (decision === 'deny' || prior?.decision === 'deny') {
      return 'denied';
    }
    if (
      prior &&
      (prior.event.toolIdentity !== registered.identity ||
        canonical(prior.event.input) !== canonical(action.input))
    ) {
      throw new Error('Committed approval action identity changed');
    }
    if (decision === 'ask' && prior?.decision !== 'approve') {
      return 'user-approval';
    }
    run.permits.set(call.toolCallId, action);
    return 'approved';
  }

  private async loop(
    run: Run,
    model: Awaited<ReturnType<HostPlatform['resolveModel']>>
  ): Promise<void> {
    let failed: string | undefined;
    let checkpointFailure: unknown;
    run.paused = false;
    const initialMessages = [...(this.messages.get(run.threadId) ?? [])];
    let recordedInputLength = initialMessages.length;
    try {
      const result = streamText({
        abortSignal: run.controller.signal,
        maxRetries: 0,
        messages: initialMessages,
        model,
        onStepFinish: async (step) => {
          // AI SDK notify() catches callback errors; keep storage failures on the host's failure path.
          // https://github.com/vercel/ai/blob/main/packages/ai/src/util/notify.ts
          // Remove this capture if the public step callback propagates failures.
          try {
            const event: HostEvent = {
              messages: step.response.messages.map((message) =>
                jsonValue(modelMessageSchema.parse(message))
              ),
              model: jsonValue(step.model),
              runId: run.id,
              stepNumber: run.steps,
              type: 'model.step',
              usage: jsonValue(step.usage),
            };
            const [row] = await this.append(run.threadId, [event]);
            if (!row) {
              throw new Error('Model step was not committed');
            }
            await this.store.syncBoundary(run.threadId);
            this.fold(row);
            recordedInputLength += step.response.messages.length;
          } catch (cause) {
            checkpointFailure = cause;
            run.controller.abort(cause);
          }
        },
        prepareStep: async ({ messages }) => {
          // Resolved approval tool results precede the first model call in the SDK.
          // Commit those public SDK messages before the provider sees them.
          if (messages.length > recordedInputLength) {
            await this.commitMessages(run, messages.slice(recordedInputLength));
            recordedInputLength = messages.length;
          }
          return {};
        },
        stopWhen: stepCountIs(this.platform.maxSteps - run.steps),
        toolApproval: ({ toolCall }) => this.sdkApproval(run, toolCall),
        tools: this.sdkTools(run),
      });
      for await (const chunk of result.fullStream) {
        if (chunk.type === 'tool-approval-request' && chunk.isAutomatic !== true) {
          const registered = this.platform.tools[chunk.toolCall.toolName];
          if (!registered) {
            throw new Error('Approval references an unknown tool');
          }
          const event: Interaction = {
            input: jsonValue(chunk.toolCall.input),
            interactionId: chunk.approvalId,
            kind: 'approval',
            runId: run.id,
            toolCallId: chunk.toolCall.toolCallId,
            toolId: chunk.toolCall.toolName,
            toolIdentity: registered.identity,
            type: 'interaction.requested',
          };
          run.approvals.set(event.interactionId, { event });
          run.paused = true;
          await this.append(run.threadId, [event]);
        }
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
    if (checkpointFailure !== undefined) {
      throw checkpointFailure;
    }
    await this.finishLoop(run, failed);
  }

  private async finishLoop(run: Run, failed: string | undefined): Promise<void> {
    if (
      !run.stopped &&
      ((run.paused && !failed && !run.controller.signal.aborted) ||
        (this.closing && run.approvals.size > 0))
    ) {
      await Promise.allSettled([...run.effects]);
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
      const pending = run.approvals.get(params.interactionId);
      if (run.terminal || !pending || pending.decision !== undefined) {
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
      pending.decision = params.decision;
      const previous = run.task;
      run.task = (previous ?? Promise.resolve()).then(() => this.continueRun(run));
      run.task.catch(() => undefined);
      return result;
    });
  }

  private async commitMessages(run: Run, messages: readonly ModelMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    const [row] = await this.append(run.threadId, [
      {
        messages: messages.map((message) => jsonValue(modelMessageSchema.parse(message))),
        runId: run.id,
        type: 'model.messages',
      },
    ]);
    if (!row) {
      throw new Error('Model context was not committed');
    }
    await this.store.syncBoundary(run.threadId);
    this.fold(row);
  }

  private approvalResponses(run: Run): ToolContent {
    const responses: ToolContent = [];
    for (const { event, decision } of run.approvals.values()) {
      if (!run.responses.has(event.interactionId)) {
        responses.push({
          approvalId: event.interactionId,
          approved: decision === 'approve',
          type: 'tool-approval-response',
        });
      }
      if (run.outputs.has(event.toolCallId) && !run.checkpointedResults.has(event.toolCallId)) {
        const output = run.outputs.get(event.toolCallId);
        responses.push({
          output:
            typeof output === 'string'
              ? { type: 'text', value: output }
              : { type: 'json', value: output ?? null },
          toolCallId: event.toolCallId,
          toolName: event.toolId,
          type: 'tool-result',
        });
      }
    }
    return responses;
  }

  private async finalApprovalResult(
    run: Run,
    { event, decision }: PendingInteraction
  ): Promise<ToolContent[number]> {
    if (decision === 'deny' || this.decision(event.toolId) === 'deny') {
      return {
        output: { type: 'execution-denied' },
        toolCallId: event.toolCallId,
        toolName: event.toolId,
        type: 'tool-result',
      };
    }
    const action: Action = {
      input: event.input,
      runId: run.id,
      toolCallId: event.toolCallId,
      toolId: event.toolId,
      toolIdentity: event.toolIdentity,
      type: 'effect.started',
    };
    run.permits.set(action.toolCallId, action);
    const output = jsonValue(await this.dispatch(run, action));
    return {
      output:
        typeof output === 'string'
          ? { type: 'text', value: output }
          : { type: 'json', value: output },
      toolCallId: event.toolCallId,
      toolName: event.toolId,
      type: 'tool-result',
    };
  }

  private async finishApprovedCalls(run: Run): Promise<void> {
    // Resolve already-issued calls at the existing step limit without another model request.
    const results: ToolContent = [];
    for (const approval of run.approvals.values()) {
      if (!run.checkpointedResults.has(approval.event.toolCallId)) {
        results.push(await this.finalApprovalResult(run, approval));
      }
    }
    await this.commitMessages(run, results.length > 0 ? [{ content: results, role: 'tool' }] : []);
    await this.finish(run, 'completed');
  }

  private async continueRun(run: Run): Promise<void> {
    if (run.terminal) {
      return;
    }
    if (run.stopped) {
      await this.finish(run, 'stopped');
      return;
    }
    if ([...run.approvals.values()].some((approval) => approval.decision === undefined)) {
      return;
    }
    try {
      // The SDK collects approvals from one final tool message, preserving parallel calls.
      const responses = this.approvalResponses(run);
      await this.commitMessages(
        run,
        responses.length > 0 ? [{ content: responses, role: 'tool' }] : []
      );
      if (run.steps >= this.platform.maxSteps) {
        await this.finishApprovedCalls(run);
        return;
      }
      const model = await this.platform.resolveModel(run.modelId);
      await this.loop(run, model);
    } catch (cause) {
      await this.finish(
        run,
        run.stopped ? 'stopped' : 'failed',
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
        run.stopped = true;
        run.controller.abort(new Error('Run stopped by user'));
        if (run.task) {
          await run.task;
        }
        if (!run.terminal) {
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
      }
    }
    await Promise.all(
      [...this.runs.values()].map(async (run) => {
        if (run.task) {
          await run.task;
          run.release?.();
          run.release = undefined;
        } else if (run.terminal || run.approvals.size > 0) {
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
