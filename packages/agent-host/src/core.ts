import { randomUUID } from 'node:crypto';
import type { StateStore } from '@brainstrike/state-store';
import {
  type LanguageModel,
  type ModelMessage,
  modelMessageSchema,
  stepCountIs,
  streamText,
  type ToolContent,
} from 'ai';
import {
  ApprovalInputReconstructionError,
  rebuildApprovedRuntimeMessages,
  validateApprovalInput,
} from './approval-input.js';
import {
  acceptHostWorkspaceSnapshot,
  createHostRunContext,
  createHostRunState,
  foldHostAcceptedCommand,
  foldHostConversationMessages,
  HostCommandLedger,
  type PendingInteraction,
  type HostRunState as Run,
  readHostWorkspaceSnapshot,
  recordHostConversationId,
} from './core-state.js';
import { readHostRow, readHostThreadHistory, storedHostEvent } from './event-storage.js';
import { healInterruptedRunHistory } from './interrupted-history.js';
import { canonical, type Json, jsonValue } from './json-value.js';
import type { HostPlatform, HostRunAdmission, HostRunOwner } from './ports.js';
import type { HostEvent, HostLogRow, HostParams } from './protocol.js';
import {
  acquireHostRunAdmission,
  assertHostRunStartAvailable,
  closeHostRunResources,
  createAdmittedHostSdkTools,
  ensureHostRunAdmission,
  hostRunToolDecision,
  hostRunTools,
  prepareHostProviderStep,
} from './run-admission.js';

export { jsonValue } from './json-value.js';

type Action = Extract<HostEvent, { type: 'effect.started' }>;
type Interaction = Extract<HostEvent, { type: 'interaction.requested' }>;
export type HostEventStore = Pick<
  StateStore,
  'append' | 'read' | 'root' | 'syncBoundary' | 'threads'
>;

/** One writer, one admission queue, and one SDK loop per root run (ADR-0011/12/17). */
export class HostCore {
  private readonly commands = new HostCommandLedger();
  private readonly threads = new Set<string>();
  private readonly workspaces = new Map<string, HostParams<'thread/workspace/set'>['snapshot']>();
  private readonly runs = new Map<string, Run>();
  private readonly messages = new Map<string, ModelMessage[]>();
  private readonly conversationIds = new Set<string>();
  private readonly listeners = new Set<(row: HostLogRow) => void>();
  private readonly pendingAdmissions = new Set<AbortController>();
  private admission: Promise<void> = Promise.resolve();
  private closing = false;
  private closeTask?: Promise<void>;

  private constructor(
    readonly store: HostEventStore,
    private readonly platform: HostPlatform,
    private readonly retainRun: () => () => void
  ) {}

  static async open(
    store: HostEventStore,
    platform: HostPlatform,
    retainRun: () => () => void,
    onAcquired?: (core: HostCore) => void
  ): Promise<HostCore> {
    const core = new HostCore(store, platform, retainRun);
    // The root owner retains partially restored actors if hydration or cleanup fails.
    onAcquired?.(core);
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
      case 'workspace.updated':
        this.workspaces.set(row.threadId, event.snapshot);
        break;
      case 'command.accepted':
        foldHostAcceptedCommand(this.commands, this.runs, event);
        if (event.method === 'run/start') {
          recordHostConversationId(this.conversationIds, event.commandId);
        }
        break;
      case 'run.started':
        recordHostConversationId(this.conversationIds, event.runId);
        this.runs.set(
          event.runId,
          createHostRunState(row.threadId, event.runId, event.modelId, event.snapshot)
        );
        this.messages.set(row.threadId, [
          ...(this.messages.get(row.threadId) ?? []),
          { content: event.prompt, role: 'user' },
        ]);
        break;
      case 'model.step':
      case 'model.messages':
        foldHostConversationMessages(this.messages, this.runs, row.threadId, event);
        break;
      case 'interaction.requested': {
        const run = this.runs.get(event.runId);
        if (!run) {
          throw new Error('Interaction references an unknown run');
        }
        const runtimeInput = run.liveInputs.get(event.toolCallId);
        run.approvals.set(event.interactionId, {
          event,
          ...(runtimeInput ? { runtimeInput } : {}),
        });
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
          run.outcome = event.outcome;
        }
        break;
      }
      default:
        break;
    }
  }

  private async append(
    threadId: string,
    events: readonly HostEvent[],
    durability: 'normal' | 'full' = 'normal',
    beforePublish?: (rows: readonly HostLogRow[]) => void
  ): Promise<HostLogRow[]> {
    const committed = await this.store.append(
      events.map((event) => storedHostEvent(threadId, event)),
      undefined,
      durability
    );
    const rows = await Promise.all(committed.map((row) => readHostRow(this.store, row)));
    beforePublish?.(rows);
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

  listThreads(): { threadId: string }[] {
    return [...this.threads].map((threadId) => ({ threadId }));
  }

  read(threadId: string, fromSeq: number): Promise<HostLogRow[]> {
    return readHostThreadHistory(this.store, this.threads, threadId, fromSeq);
  }

  readWorkspace(threadId: string): ReturnType<typeof readHostWorkspaceSnapshot> {
    return readHostWorkspaceSnapshot(this.threads, this.workspaces, threadId);
  }

  setWorkspace(params: HostParams<'thread/workspace/set'>): Promise<{ accepted: true }> {
    return this.command('thread/workspace/set', params, () =>
      acceptHostWorkspaceSnapshot(params, this.threads, (event) =>
        this.accept(
          params.threadId,
          'thread/workspace/set',
          params,
          { accepted: true },
          [event],
          () => this.workspaces.set(params.threadId, event.snapshot)
        )
      )
    );
  }

  private command<T extends Json>(
    method: string,
    params: { commandId: string },
    perform: () => Promise<T>,
    repeat?: (result: T) => Promise<T>
  ): Promise<T> {
    const result = this.admission.then(async () => {
      if (this.closing) {
        throw new Error('Host is closing');
      }
      return this.commands.perform(method, params, perform, repeat);
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
    events: readonly HostEvent[],
    beforePublish?: () => void
  ): Promise<void> {
    const accepted: HostEvent = {
      commandId: params.commandId,
      method,
      payload: jsonValue(params),
      result,
      type: 'command.accepted',
    };
    await this.append(threadId, [accepted, ...events], 'normal', beforePublish);
    this.commands.commit(params.commandId, {
      method,
      payload: canonical(accepted.payload),
      result,
    });
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
      assertHostRunStartAvailable(this.runs.values(), params.threadId);
      if (this.conversationIds.has(params.commandId)) {
        throw new Error('Input command collides with a committed conversation identity');
      }
      const controller = new AbortController();
      this.pendingAdmissions.add(controller);
      let admission: HostRunAdmission | undefined;
      let release: (() => void) | undefined;
      try {
        admission = await acquireHostRunAdmission(this.platform, {
          ...(params.configuration ? { configuration: params.configuration } : {}),
          modelId: params.modelId,
          prompt: params.prompt,
          signal: controller.signal,
          threadId: params.threadId,
        });
        controller.signal.throwIfAborted();
        release = this.retainRun();
        const run = createHostRunState(
          params.threadId,
          randomUUID(),
          params.modelId,
          admission.snapshot,
          controller
        );
        run.admission = admission;
        if (this.conversationIds.has(run.id) || run.id === params.commandId) {
          throw new Error('Generated run collides with a committed conversation identity');
        }
        run.release = release;
        const result = { runId: run.id };
        await this.accept(params.threadId, 'run/start', params, result, [
          {
            modelId: params.modelId,
            prompt: params.prompt,
            runId: run.id,
            snapshot: admission.snapshot,
            type: 'run.started',
          },
        ]);
        this.runs.set(run.id, run);
        recordHostConversationId(this.conversationIds, params.commandId);
        recordHostConversationId(this.conversationIds, run.id);
        this.messages.set(params.threadId, [
          ...(this.messages.get(params.threadId) ?? []),
          { content: params.prompt, role: 'user' },
        ]);
        run.task = this.loop(run, admission.model);
        // Stop/close joins this task; retain failures rather than leaking rejections.
        run.task.catch(() => undefined);
        return result;
      } catch (cause) {
        controller.abort(cause);
        try {
          await admission?.close?.();
          release?.();
        } catch (cleanup) {
          throw new AggregateError([cause, cleanup], 'Run admission cleanup failed');
        }
        throw cause;
      } finally {
        this.pendingAdmissions.delete(controller);
      }
    });
  }

  private async execute(run: Run, action: Action, input: unknown): Promise<unknown> {
    const registered = hostRunTools(run)[action.toolId];
    const permitted = run.permits.get(action.toolCallId);
    if (!registered || registered.identity !== action.toolIdentity || permitted !== action) {
      throw new Error('Tool execution lacks its exact host permission decision');
    }
    run.permits.delete(action.toolCallId);
    run.controller.signal.throwIfAborted();
    if ((await hostRunToolDecision(this.platform, run, action.toolId)) === 'deny') {
      throw new Error('Tool permission was revoked');
    }
    run.controller.signal.throwIfAborted();
    await this.append(run.threadId, [action]);
    run.started.add(action.toolCallId);
    run.controller.signal.throwIfAborted();
    // The public SDK already validated/transformed this exact admitted input.
    // Revalidating a canonical value can transform it a second time.
    const output = await registered.execute(input, {
      runId: run.id,
      signal: run.controller.signal,
      threadId: run.threadId,
      toolCallId: action.toolCallId,
      write: async (chunk: unknown): Promise<void> => {
        run.controller.signal.throwIfAborted();
        await this.append(run.threadId, [
          { chunk: jsonValue(chunk), runId: run.id, type: 'stream.chunk' },
        ]);
      },
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

  private dispatch(run: Run, action: Action, input: unknown): Promise<unknown> {
    const effect = this.execute(run, action, input);
    run.effects.add(effect);
    const joined = (): void => {
      run.effects.delete(effect);
    };
    effect.then(joined, joined);
    return effect;
  }

  private async sdkApproval(
    run: Run,
    call: { toolName: string; toolCallId: string; input: unknown }
  ): Promise<'approved' | 'denied' | 'user-approval'> {
    run.controller.signal.throwIfAborted();
    const registered = hostRunTools(run)[call.toolName];
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
    const decision = await hostRunToolDecision(this.platform, run, call.toolName);
    run.controller.signal.throwIfAborted();
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
      run.liveInputs.set(call.toolCallId, { value: call.input });
      return 'user-approval';
    }
    run.permits.set(call.toolCallId, action);
    return 'approved';
  }

  private async loop(run: Run, model: LanguageModel): Promise<void> {
    let failed: string | undefined;
    let interrupted = false;
    let checkpointFailure: unknown;
    run.paused = false;
    const initialMessages = [...(this.messages.get(run.threadId) ?? [])];
    let recordedInputLength = initialMessages.length;
    let historyPrepared = false;
    try {
      const owner = await this.openRun(run);
      const admission = await ensureHostRunAdmission(this.platform, run);
      const result = streamText({
        abortSignal: run.controller.signal,
        maxRetries: 0,
        messages: await rebuildApprovedRuntimeMessages({
          approvals: [...run.approvals.values()],
          checkpointedResults: run.checkpointedResults,
          inputBinding: (event) => {
            const input = run.approvals.get(event.interactionId)?.runtimeInput;
            if (!input) {
              throw new Error('Approved runtime input was not acquired');
            }
            return input;
          },
          messageIndexes: run.messageIndexes,
          messages: initialMessages,
          resolveInput: (event) => this.approvalInput(run, event),
        }),
        model: owner?.prepareHostModel?.(model) ?? model,
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
            const interactions: Interaction[] = step.content.flatMap((part) => {
              if (part.type !== 'tool-approval-request' || part.isAutomatic === true) {
                return [];
              }
              const registered = hostRunTools(run)[part.toolCall.toolName];
              if (!registered) {
                throw new Error('Approval references an unknown tool');
              }
              return [
                {
                  input: jsonValue(part.toolCall.input),
                  interactionId: part.approvalId,
                  kind: 'approval',
                  runId: run.id,
                  toolCallId: part.toolCall.toolCallId,
                  toolId: part.toolCall.toolName,
                  toolIdentity: registered.identity,
                  type: 'interaction.requested',
                },
              ];
            });
            // The complete public SDK context and its answerable interactions
            // share one SQLite commit, including when the provider stream is interrupted.
            const rows = await this.append(
              run.threadId,
              [event, ...interactions],
              'full',
              (committed) => {
                for (const row of committed) {
                  this.fold(row);
                }
              }
            );
            const row = rows[0];
            if (!row) {
              throw new Error('Model step was not committed');
            }
            recordedInputLength += step.response.messages.length;
            await owner?.commitHostStep?.();
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
          let prepared = messages;
          if (!historyPrepared) {
            historyPrepared = true;
            prepared = healInterruptedRunHistory(messages, [...this.runs.values()], run.threadId);
            recordedInputLength = prepared.length;
          }
          const memory = await owner?.prepareHostStep?.({
            messages: prepared,
            stepNumber: run.steps,
          });
          recordedInputLength = memory?.messages.length ?? prepared.length;
          if (!admission.provider) {
            return memory ?? { messages: prepared };
          }
          const provider = await admission.provider.prepare({
            configuration: admission.configuration,
            messages: memory?.messages ?? prepared,
            modelId: run.modelId,
            signal: run.controller.signal,
          });
          return prepareHostProviderStep(provider, memory?.system, owner);
        },
        stopWhen: stepCountIs(admission.snapshot.maxSteps - run.steps),
        toolApproval: ({ toolCall }) => this.sdkApproval(run, toolCall),
        tools: createAdmittedHostSdkTools(run, (action, input) =>
          this.dispatch(run, action, input)
        ),
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
      interrupted = cause instanceof ApprovalInputReconstructionError;
      failed = cause instanceof Error ? cause.message : String(cause);
    }
    if (checkpointFailure !== undefined) {
      throw checkpointFailure;
    }
    await this.finishLoop(run, failed, interrupted);
  }

  private async finishLoop(
    run: Run,
    failed: string | undefined,
    interrupted = false
  ): Promise<void> {
    if (
      !run.stopped &&
      ((run.paused && failed === undefined && !run.controller.signal.aborted) ||
        (this.closing && run.approvals.size > 0))
    ) {
      await Promise.allSettled([...run.effects]);
      return;
    }
    const outcome = run.controller.signal.aborted
      ? this.closing
        ? 'interrupted'
        : 'stopped'
      : interrupted
        ? 'interrupted'
        : failed === undefined
          ? 'completed'
          : 'failed';
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
      await ensureHostRunAdmission(this.platform, run);
      const registered = hostRunTools(run)[pending.event.toolId];
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

  private async modelResult(
    run: Run,
    toolCallId: string,
    toolId: string,
    input: unknown,
    output: unknown
  ): Promise<ToolContent[number]> {
    const project = hostRunTools(run)[toolId]?.toModelOutput;
    return {
      output: project
        ? await project({ input, output, toolCallId })
        : typeof output === 'string'
          ? { type: 'text', value: output }
          : { type: 'json', value: jsonValue(output) },
      toolCallId,
      toolName: toolId,
      type: 'tool-result',
    };
  }

  private async approvalInput(run: Run, event: Interaction): Promise<unknown> {
    const approval = run.approvals.get(event.interactionId);
    if (!approval) {
      throw new Error('Unknown approval occurrence');
    }
    const registered = hostRunTools(run)[event.toolId];
    if (!registered || registered.identity !== event.toolIdentity) {
      throw new Error('Approval tool identity changed');
    }
    approval.runtimeInput ??= {
      value: await validateApprovalInput(registered, event, run.rawInputs),
    };
    return approval.runtimeInput.value;
  }

  private async approvalResponses(run: Run): Promise<ToolContent> {
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
        responses.push(
          await this.modelResult(
            run,
            event.toolCallId,
            event.toolId,
            await this.approvalInput(run, event),
            output ?? null
          )
        );
      }
    }
    return responses;
  }

  private async finalApprovalResult(
    run: Run,
    { event, decision }: PendingInteraction
  ): Promise<ToolContent[number]> {
    if (
      decision === 'deny' ||
      (await hostRunToolDecision(this.platform, run, event.toolId)) === 'deny'
    ) {
      return {
        output: { type: 'execution-denied' },
        toolCallId: event.toolCallId,
        toolName: event.toolId,
        type: 'tool-result',
      };
    }
    const input = await this.approvalInput(run, event);
    const action: Action = {
      input: event.input,
      runId: run.id,
      toolCallId: event.toolCallId,
      toolId: event.toolId,
      toolIdentity: event.toolIdentity,
      type: 'effect.started',
    };
    run.permits.set(action.toolCallId, action);
    const output = await this.dispatch(run, action, input);
    return this.modelResult(run, event.toolCallId, event.toolId, input, output);
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
      const admission = await ensureHostRunAdmission(this.platform, run);
      await this.openRun(run);
      // The SDK collects approvals from one final tool message, preserving parallel calls.
      const responses = await this.approvalResponses(run);
      await this.commitMessages(
        run,
        responses.length > 0 ? [{ content: responses, role: 'tool' }] : []
      );
      if (run.steps >= admission.snapshot.maxSteps) {
        await this.finishApprovedCalls(run);
        return;
      }
      await this.loop(run, admission.model);
    } catch (cause) {
      if (run.completion) {
        throw cause;
      }
      await this.finish(
        run,
        run.stopped
          ? 'stopped'
          : cause instanceof ApprovalInputReconstructionError
            ? 'interrupted'
            : 'failed',
        cause instanceof Error ? cause.message : String(cause)
      );
    }
  }

  stop(params: HostParams<'run/stop'>): Promise<{ outcome: 'stopped' | 'already-terminal' }> {
    const join = async (): Promise<void> => {
      const run = this.run(params.threadId, params.runId);
      run.stopped = true;
      run.controller.abort(new Error('Run stopped by user'));
      const joined = await Promise.allSettled([
        run.task ?? Promise.resolve(),
        this.closeRunOwner(run),
      ]);
      const failures = [
        ...new Set(
          joined.filter((result) => result.status === 'rejected').map((result) => result.reason)
        ),
      ];
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, 'Stop cleanup failed');
      }
      await this.finish(run, 'stopped');
    };
    return this.command(
      'run/stop',
      params,
      async () => {
        const run = this.run(params.threadId, params.runId);
        const result = {
          outcome: run.terminal ? ('already-terminal' as const) : ('stopped' as const),
        };
        if (run.stopAcceptance) {
          await join();
          await run.stopAcceptance;
          return result;
        }
        const acceptance = Promise.withResolvers<void>();
        run.stopAcceptance = acceptance.promise;
        acceptance.promise.catch(() => undefined);
        run.stopped = true;
        run.controller.abort(new Error('Run stopped by user'));
        try {
          await this.accept(run.threadId, 'run/stop', params, result, []);
          acceptance.resolve();
          run.stopAcceptance = undefined;
        } catch (cause) {
          acceptance.reject(cause);
          const cleanup = await Promise.allSettled([join()]);
          const failure = cleanup[0];
          if (failure?.status === 'rejected' && failure.reason !== cause) {
            throw new AggregateError(
              [cause, failure.reason],
              'Stop persistence and cleanup failed'
            );
          }
          throw cause;
        }
        await join();
        return result;
      },
      async (result) => {
        // The committed command records intent, not proof of physical cleanup.
        // Repeated Stop must observe the same joined completion, including failure.
        await join();
        return result;
      }
    );
  }

  private openRun(run: Run): Promise<HostRunOwner | undefined> {
    run.owner ??= ensureHostRunAdmission(this.platform, run).then((admission) => {
      const open = admission.openRun ?? this.platform.openRun?.bind(this.platform);
      return open?.(
        createHostRunContext(run, (threadId, events) => this.append(threadId, events, 'full'))
      );
    });
    return run.owner;
  }

  private closeRunOwner(run: Run): Promise<void> {
    run.ownerClose ??= closeHostRunResources(run);
    return run.ownerClose;
  }

  private finish(
    run: Run,
    outcome: Extract<HostEvent, { type: 'run.finished' }>['outcome'],
    detail?: string
  ): Promise<void> {
    if (run.completion) {
      return run.completion;
    }
    if (run.terminal) {
      return this.closeRunOwner(run);
    }
    run.completion = (async () => {
      // SDK abort can end its stream before a tool's physical process exits.
      // Only the host owns terminal admission, so join all dispatched work first.
      await Promise.allSettled([...run.effects]);
      await this.closeRunOwner(run);
      await run.stopAcceptance;
      const joinedOutcome = run.stopped
        ? 'stopped'
        : run.controller.signal.aborted && this.closing
          ? 'interrupted'
          : outcome;
      await this.append(
        run.threadId,
        [
          {
            outcome: joinedOutcome,
            runId: run.id,
            type: 'run.finished',
            ...(detail === undefined ? {} : { detail }),
          },
        ],
        'full',
        () => {
          run.terminal = true;
          run.outcome = joinedOutcome;
          run.release?.();
          run.release = undefined;
        }
      );
    })();
    return run.completion;
  }

  close(): Promise<void> {
    this.closeTask ??= this.closeOwned();
    return this.closeTask;
  }

  private async closeOwned(): Promise<void> {
    this.closing = true;
    for (const controller of this.pendingAdmissions) {
      controller.abort(new Error('Host is closing'));
    }
    for (const run of this.runs.values()) {
      run.controller.abort(new Error('Host is closing'));
    }
    await this.admission;
    for (const run of this.runs.values()) {
      run.controller.abort(new Error('Host is closing'));
    }
    const joined = await Promise.allSettled(
      [...this.runs.values()].map(async (run) => {
        const task = await Promise.allSettled([run.task ?? Promise.resolve()]);
        const owner = await Promise.allSettled([this.closeRunOwner(run)]);
        const results = [...task, ...owner];
        const failures = results.filter((result) => result.status === 'rejected');
        if (failures.length > 0) {
          throw new AggregateError(
            failures.map((result) => result.reason),
            'Run cleanup failed'
          );
        }
        if (!run.terminal && run.approvals.size === 0) {
          await this.finish(run, 'interrupted', 'Host closed with a pending decision');
        }
      })
    );
    const platform = await Promise.allSettled([this.platform.close()]);
    const failures = [...joined, ...platform].filter((result) => result.status === 'rejected');
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Host cleanup failed'
      );
    }
    for (const run of this.runs.values()) {
      run.release?.();
      run.release = undefined;
    }
    this.listeners.clear();
  }
}
