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
} from './approval-input.js';
import { HostMcpInputLedger } from './core-mcp-input.js';
import {
  abortHostThreadRuns,
  assertHostAdmissionCleanup,
  joinHostClosingRun,
  joinHostRunOwner,
  joinHostThreadDeletion,
  reconcileOpenedHostRuns,
  rejectHostRunAdmission,
} from './core-run-lifecycle.js';
import {
  acceptHostWorkspaceSnapshot,
  createHostRunContext,
  createHostRunState,
  foldHostAcceptedCommand,
  foldHostConversationMessages,
  HostCommandLedger,
  hasHostInteractionResponse,
  type HostRunState as Run,
  readHostWorkspaceSnapshot,
  recordHostConversationId,
} from './core-state.js';
import { readHostRow, readHostThreadHistory, storedHostEvent } from './event-storage.js';
import { healInterruptedRunHistory } from './interrupted-history.js';
import { canonical, type Json, jsonValue } from './json-value.js';
import type { HostPlatform, HostRunAdmission, HostRunOwner } from './ports.js';
import type { HostEvent, HostLogRow, HostParams } from './protocol.js';
import { finishHostRunWithProviderBilling } from './provider-billing-diagnostics.js';
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

import {
  createHostApprovalResponses,
  resolveApprovedHostCall,
  resolveHostApprovalInput,
  validateHostInteractionResume,
} from './run-continuation.js';

export { jsonValue } from './json-value.js';

type Action = Extract<HostEvent, { type: 'effect.started' }>;
type Interaction = Extract<HostEvent, { type: 'interaction.requested' }>;
export type HostEventStore = Pick<
  StateStore,
  'append' | 'read' | 'root' | 'syncBoundary' | 'threads'
> & { readonly deleteThread?: StateStore['deleteThread'] };

/** One writer, one admission queue, and one SDK loop per root run (ADR-0011/12/17). */
export class HostCore {
  private readonly commands = new HostCommandLedger();
  private readonly threads = new Set<string>();
  private readonly workspaces = new Map<string, HostParams<'thread/workspace/set'>['snapshot']>();
  private readonly runs = new Map<string, Run>();
  private readonly messages = new Map<string, ModelMessage[]>();
  private readonly conversationIds = new Set<string>();
  private readonly listeners = new Set<(row: HostLogRow) => void>();
  private readonly pendingAdmissions = new Map<AbortController, string>();
  private readonly failedAdmissions = new Map<string, unknown>();
  private readonly deletions = new Map<string, Promise<{ deleted: true }>>();
  private admission: Promise<void> = Promise.resolve();
  private closing = false;
  private closeTask?: Promise<void>;
  private readonly mcpInput = new HostMcpInputLedger({
    append: (threadId, events) => this.append(threadId, events, 'full'),
    closing: () => this.closing,
    deleting: (threadId) => this.deletions.has(threadId),
    runs: () => this.runs,
  });

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
    await reconcileOpenedHostRuns(core.runs.values(), {
      continueRun: (run) => core.continueRun(run),
      finish: (run, outcome, detail) => core.finish(run, outcome, detail),
      retainRun,
    });
    // From startup on, Core is the single consent surface for host-run MCP input.
    await core.mcpInput.open(platform.mcpInput);
    return core;
  }

  private fold(row: HostLogRow): void {
    const event = row.event;
    switch (event.type) {
      case 'workspace.updated':
        this.workspaces.set(row.threadId, event.snapshot);
        break;
      case 'command.accepted':
        foldHostAcceptedCommand(this.commands, this.runs, event, row.threadId);
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
          if ('decision' in event) {
            approval.decision = event.decision;
          } else {
            approval.resumeData = event.resumeData;
          }
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
      case 'input.requested':
      case 'input.retired':
        this.mcpInput.fold(row.threadId, event);
        break;
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
    params: { commandId: string; threadId?: string },
    perform: () => Promise<T>,
    repeat?: (result: T) => Promise<T>
  ): Promise<T> {
    const result = this.admission.then(async () => {
      if (this.closing) {
        throw new Error('Host is closing');
      }
      if (params.threadId) {
        if (!this.threads.has(params.threadId)) {
          throw new Error('Unknown thread');
        }
        if (this.deletions.has(params.threadId)) {
          throw new Error('Thread deletion has closed command admission');
        }
        assertHostAdmissionCleanup(this.failedAdmissions, params.threadId);
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
      threadId,
    });
  }

  /** BST-1977: raw StateStore deletion cannot retire active Memory/provider work. */
  deleteThread(params: { readonly threadId: string }): Promise<{ deleted: true }> {
    const existing = this.deletions.get(params.threadId);
    if (existing) {
      return existing;
    }
    if (this.closing) {
      return Promise.reject(new Error('Host is closing'));
    }
    if (!this.threads.has(params.threadId)) {
      return Promise.reject(new Error('Unknown thread'));
    }
    const erase = this.store.deleteThread?.bind(this.store);
    if (!erase) {
      return Promise.reject(new Error('The Root owner has no thread deletion capability'));
    }
    const deletion = this.admission.then(async (): Promise<{ deleted: true }> => {
      if (this.closing) {
        throw new Error('Host is closing');
      }
      assertHostAdmissionCleanup(this.failedAdmissions, params.threadId);
      const runs = [...this.runs.values()].filter((run) => run.threadId === params.threadId);
      await joinHostThreadDeletion(
        runs,
        (run) => this.closeRunOwner(run),
        (run) => this.finish(run, 'stopped')
      );
      await this.mcpInput.joinThread(params.threadId);
      await erase(params.threadId);
      for (const commandId of this.commands.forgetThread(params.threadId)) {
        this.conversationIds.delete(commandId);
      }
      this.threads.delete(params.threadId);
      this.messages.delete(params.threadId);
      this.workspaces.delete(params.threadId);
      for (const run of runs) {
        this.runs.delete(run.id);
        this.conversationIds.delete(run.id);
      }
      return { deleted: true };
    });
    this.deletions.set(params.threadId, deletion);
    abortHostThreadRuns(params.threadId, this.pendingAdmissions, this.runs.values());
    this.admission = deletion.then(
      () => undefined,
      () => undefined
    );
    return deletion;
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
      this.pendingAdmissions.set(controller, params.threadId);
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
        return await rejectHostRunAdmission(
          params.threadId,
          cause,
          admission,
          release,
          this.failedAdmissions
        );
      } finally {
        this.pendingAdmissions.delete(controller);
      }
    });
  }

  private async execute(
    run: Run,
    action: Action,
    input: unknown,
    resumeData?: unknown
  ): Promise<unknown> {
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
      ...(resumeData === undefined ? {} : { resumeData }),
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

  private dispatch(
    run: Run,
    action: Action,
    input: unknown,
    resumeData?: unknown
  ): Promise<unknown> {
    const effect = this.execute(run, action, input, resumeData);
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
    if (registered.interaction) {
      run.liveInputs.set(call.toolCallId, { value: call.input });
      return 'user-approval';
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
          resolveInput: (event) => resolveHostApprovalInput(run, event),
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
                  kind: registered.interaction?.kind ?? 'approval',
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
      if (
        run.terminal ||
        !pending ||
        pending.event.kind !== 'approval' ||
        hasHostInteractionResponse(pending)
      ) {
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

  resume(params: HostParams<'interaction/resume'>): Promise<{ accepted: true }> {
    return this.command('interaction/resume', params, async () => {
      const run = this.run(params.threadId, params.runId);
      const pending = run.approvals.get(params.interactionId);
      if (
        run.terminal ||
        !pending ||
        pending.event.kind === 'approval' ||
        hasHostInteractionResponse(pending)
      ) {
        throw new Error('Human interaction is stale or belongs to another run');
      }
      await ensureHostRunAdmission(this.platform, run);
      await validateHostInteractionResume(run, pending, params.resumeData);
      const result = { accepted: true as const };
      await this.accept(run.threadId, 'interaction/resume', params, result, [
        {
          interactionId: params.interactionId,
          resumeData: params.resumeData,
          runId: run.id,
          type: 'interaction.responded',
        },
      ]);
      pending.resumeData = params.resumeData;
      const previous = run.task;
      run.task = (previous ?? Promise.resolve()).then(() => this.continueRun(run));
      run.task.catch(() => undefined);
      return result;
    });
  }

  /** A client's answer to committed MCP input; the presenter alone settles it. */
  settleInput(params: HostParams<'input/settle'>): Promise<{ accepted: true }> {
    return this.mcpInput.settle(params);
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

  private async finishApprovedCalls(run: Run): Promise<void> {
    // Resolve already-issued calls at the existing step limit without another model request.
    const results: ToolContent = [];
    for (const approval of run.approvals.values()) {
      if (!run.checkpointedResults.has(approval.event.toolCallId)) {
        results.push(
          await resolveApprovedHostCall(run, approval, this.platform, (action, input, resumeData) =>
            this.dispatch(run, action, input, resumeData)
          )
        );
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
    if ([...run.approvals.values()].some((approval) => !hasHostInteractionResponse(approval))) {
      return;
    }
    try {
      const admission = await ensureHostRunAdmission(this.platform, run);
      await this.openRun(run);
      // The SDK collects approvals from one final tool message, preserving parallel calls.
      const responses = await createHostApprovalResponses(
        run,
        this.platform,
        (action, input, resumeData) => this.dispatch(run, action, input, resumeData)
      );
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
      await joinHostRunOwner(run, (owned) => this.closeRunOwner(owned));
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
    return finishHostRunWithProviderBilling(
      run,
      outcome,
      detail,
      () => this.closing,
      (owned) => this.closeRunOwner(owned),
      () => this.read(run.threadId, 0),
      (event, commit) => this.append(run.threadId, [event], 'full', commit)
    );
  }

  close(): Promise<void> {
    this.closeTask ??= this.closeOwned();
    return this.closeTask;
  }

  private async closeOwned(): Promise<void> {
    this.closing = true;
    for (const controller of this.pendingAdmissions.keys()) {
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
      [...this.runs.values()].map((run) =>
        joinHostClosingRun(
          run,
          (owned) => this.closeRunOwner(owned),
          (owned) => this.finish(owned, 'interrupted', 'Host closed with a pending decision')
        )
      )
    );
    const platform = await Promise.allSettled([this.platform.close()]);
    // The presenter's close finalizes remaining input; join those retirements.
    const mcpInput = await this.mcpInput.close();
    const failures = [
      ...this.failedAdmissions.values(),
      ...[...joined, ...platform]
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason),
      ...mcpInput,
    ];
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Host cleanup failed');
    }
    for (const run of this.runs.values()) {
      run.release?.();
      run.release = undefined;
    }
    this.listeners.clear();
  }
}
