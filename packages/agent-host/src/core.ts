import { randomUUID } from 'node:crypto';
import type { StateStore } from '@brainstrike/state-store';
import {
  type LanguageModel,
  type ModelMessage,
  modelMessageSchema,
  stepCountIs,
  streamText,
} from 'ai';
import {
  ApprovalInputReconstructionError,
  rebuildApprovedRuntimeMessages,
} from './approval-input.js';
import {
  type HostChildRunPort,
  HostChildRuns,
  hostDeliveryPosition,
  reportHostChildWakeFailure,
} from './core-child-runs.js';
import { reportRetiredHostOutcomes } from './core-retirement.js';
import {
  abortHostThreadRuns,
  acceptHostRunStop,
  assertHostAdmissionCleanup,
  finishHostSdkLoop,
  joinAllHostWork,
  joinHostRunOwner,
  joinHostThreadDeletion,
  queueHostAdmission,
  recoverHostRun,
  rejectHostRunAdmission,
  retainHostRunWork,
  retireHostRuns,
} from './core-run-lifecycle.js';
import {
  createHostRunContext,
  foldHostAcceptedCommand,
  foldHostInteraction,
  foldHostRunEffect,
  HostCommandLedger,
  hasHostInteractionResponse,
  type HostRunState as Run,
  recordHostConversationId,
} from './core-state.js';
import { performHostToolEffect } from './core-tool-effect.js';
import { readHostRow, readHostThreadHistory, storedHostEvent } from './event-storage.js';
import { healInterruptedRunHistory } from './interrupted-history.js';
import { canonical, type Json, jsonValue } from './json-value.js';
import { type HostMcpInputClient, HostMcpInputState } from './mcp-input-state.js';
import type { HostPlatform, HostRunAdmission, HostRunOwner } from './ports.js';
import {
  type HostEvent,
  type HostLogRow,
  type HostParams,
  type HostResults,
  parseHostParams,
} from './protocol.js';
import { finishHostRunWithProviderBilling } from './provider-billing-diagnostics.js';
import {
  acquireHostRunAdmission,
  closeHostRunResources,
  createAdmittedHostSdkTools,
  decideHostSdkApproval,
  ensureHostRunAdmission,
  hostRunToolDecision,
  hostRunTools,
  hostStepInteractions,
  prepareHostProviderStep,
} from './run-admission.js';
import {
  admittedHostRun,
  assertHostRunAdmissible,
  foldHostConversationMessages,
  foldHostRunAdmission,
  foldHostStartedRun,
  type HostRunAdmissionCommand,
  type HostRunPosition,
  hostRegeneratePosition,
  hostRunAncestors,
  hostRunContext,
  hostStartPosition,
} from './run-branch.js';

import {
  commitHostInteractionResponse,
  commitHostModelMessages,
  createHostApprovalResponses,
  finishApprovedHostResults,
  resolveHostApprovalInput,
} from './run-continuation.js';
import { HostThreadPresentationState } from './thread-presentation-state.js';
import { HostThreadWorkspaceState } from './workspace-state.js';

export { jsonValue } from './json-value.js';

type Action = Extract<HostEvent, { type: 'effect.started' }>;
export type HostEventStore = Pick<
  StateStore,
  'append' | 'read' | 'root' | 'syncBoundary' | 'threads'
> & { readonly deleteThread?: StateStore['deleteThread'] };

/** One writer, one admission queue, and one SDK loop per root run (ADR-0011/12/17). */
export class HostCore {
  private readonly commands = new HostCommandLedger();
  private readonly mcpInputs = new HostMcpInputState();
  private readonly threads = new Set<string>();
  private readonly presentations = new HostThreadPresentationState({
    admit: (threadId, perform) => this.admit(threadId, perform),
    append: async (threadId, event) => {
      await this.append(threadId, [event], 'normal', this.foldRows);
    },
    update: (params, event) =>
      this.accept(
        params.threadId,
        'thread/update',
        params,
        { accepted: true },
        [event],
        this.foldRows
      ),
  });
  private readonly workspaces = new HostThreadWorkspaceState((method, params, event, durability) =>
    this.accept(
      params.threadId,
      method,
      params,
      { accepted: true },
      [event],
      this.foldRows,
      durability
    )
  );
  private readonly runs = new Map<string, Run>();
  private readonly children = new HostChildRuns();
  private readonly admittedRuns = new Map<string, HostRunAdmissionCommand>();
  private readonly conversationIds = new Set<string>();
  private readonly listeners = new Set<(row: HostLogRow) => void>();
  private readonly pendingAdmissions = new Map<AbortController, string>();
  private readonly failedAdmissions = new Map<string, unknown>();
  private readonly deletions = new Map<string, Promise<{ deleted: true }>>();
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
      const recovery = recoverHostRun(run);
      if (recovery?.kind === 'finish') {
        // Q-2: the boot sweep never wakes a parent; its results reach the next user turn.
        await core.finish(run, recovery.outcome, recovery.detail, false);
      } else if (recovery) {
        run.release = retainRun();
        if (recovery.kind === 'continue') {
          run.task = core.continueRun(run);
          run.task.catch(() => undefined);
        }
      }
    }
    return core;
  }

  private fold(row: HostLogRow): void {
    this.mcpInputs.fold(row);
    this.presentations.fold(row);
    this.workspaces.fold(row);
    const event = row.event;
    switch (event.type) {
      case 'command.accepted':
        foldHostAcceptedCommand(this.commands, this.runs, event, row.threadId);
        foldHostRunAdmission(this.admittedRuns, this.conversationIds, event);
        break;
      case 'run.started':
        foldHostStartedRun(
          this.admittedRuns,
          this.conversationIds,
          this.runs,
          row.threadId,
          event,
          (threadId) => this.children.isChild(threadId)
        );
        break;
      case 'model.step':
      case 'model.messages':
        foldHostConversationMessages(this.runs, event);
        break;
      case 'interaction.requested':
      case 'interaction.responded':
        foldHostInteraction(this.runs, event);
        break;
      default:
        foldHostRunEffect(this.runs, event);
        break;
    }
    this.children.fold(row, this.runs);
  }

  private append(
    threadId: string,
    events: readonly HostEvent[],
    durability: 'normal' | 'full' = 'normal',
    beforePublish?: (rows: readonly HostLogRow[]) => void
  ): Promise<HostLogRow[]> {
    return this.appendAcross(
      events.map((event) => ({ event, threadId })),
      durability,
      beforePublish
    );
  }

  /** One StateStore transaction, possibly across threads (a parent and its new child). */
  private async appendAcross(
    items: readonly { readonly event: HostEvent; readonly threadId: string }[],
    durability: 'normal' | 'full' = 'normal',
    beforePublish?: (rows: readonly HostLogRow[]) => void
  ): Promise<HostLogRow[]> {
    const committed = await this.store.append(
      items.map(({ event, threadId }) => storedHostEvent(threadId, event)),
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

  /** Child threads are reached through their parent, never listed as top-level threads. */
  listThreads(): HostResults['thread/list']['threads'] {
    return [...this.threads]
      .filter((threadId) => !this.children.isChild(threadId))
      .map((threadId) => ({ threadId, ...this.presentations.read(threadId) }));
  }

  updateThread(params: HostParams<'thread/update'>): Promise<{ accepted: true }> {
    return this.command('thread/update', params, () => this.presentations.update(params));
  }

  read(threadId: string, fromSeq: number): Promise<HostLogRow[]> {
    return readHostThreadHistory(this.store, this.threads, threadId, fromSeq);
  }

  readWorkspace(threadId: string): ReturnType<HostThreadWorkspaceState['readSnapshot']> {
    return this.workspaces.readSnapshot(this.threads, threadId);
  }

  setWorkspace(params: HostParams<'thread/workspace/set'>): Promise<{ accepted: true }> {
    return this.command('thread/workspace/set', params, () =>
      this.workspaces.setSnapshot(params, this.threads)
    );
  }

  readWorkspaceBinding(threadId: string): ReturnType<HostThreadWorkspaceState['readBinding']> {
    return this.workspaces.readBinding(this.threads, threadId);
  }

  updateWorkspaceBinding(
    params: HostParams<'thread/workspace/binding/update'>
  ): Promise<{ accepted: true }> {
    return this.command('thread/workspace/binding/update', params, () =>
      this.workspaces.setBinding(params, this.platform, this.pendingAdmissions)
    );
  }

  private command<T extends Json>(
    method: string,
    params: { commandId: string; threadId?: string },
    perform: () => Promise<T>,
    repeat?: (result: T) => Promise<T>
  ): Promise<T> {
    return this.admit(params.threadId, () =>
      this.commands.perform(method, params, perform, repeat)
    );
  }

  private admit<T>(
    threadId: string | undefined,
    perform: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const queued = queueHostAdmission(
      this.admission,
      () => {
        if (this.closing) {
          throw new Error('Host is closing');
        }
        if (threadId) {
          if (!this.threads.has(threadId)) {
            throw new Error('Unknown thread');
          }
          if (this.deletions.has(threadId)) {
            throw new Error('Thread deletion has closed command admission');
          }
          assertHostAdmissionCleanup(this.failedAdmissions, threadId);
        }
        return perform();
      },
      signal
    );
    this.admission = queued.tail;
    return queued.result;
  }

  private readonly foldRows = (rows: readonly HostLogRow[]): void => {
    for (const row of rows) {
      this.fold(row);
    }
  };

  private async accept(
    threadId: string,
    method: string,
    params: { commandId: string },
    result: Json,
    events: readonly HostEvent[],
    beforePublish?: (rows: readonly HostLogRow[]) => void,
    durability: 'normal' | 'full' = 'normal'
  ): Promise<void> {
    const accepted: HostEvent = {
      commandId: params.commandId,
      method,
      payload: jsonValue(params),
      result,
      type: 'command.accepted',
    };
    await this.append(threadId, [accepted, ...events], durability, beforePublish);
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
    // BST-1932: a thread's child threads go with it, deepest first, through this path.
    const subtree = this.children.subtree(params.threadId);
    const deletion = this.admission.then(async (): Promise<{ deleted: true }> => {
      if (this.closing) {
        throw new Error('Host is closing');
      }
      for (const threadId of subtree) {
        assertHostAdmissionCleanup(this.failedAdmissions, threadId);
      }
      const runs = [...this.runs.values()].filter((run) => subtree.includes(run.threadId));
      await joinHostThreadDeletion(
        runs,
        (run) => this.closeRunOwner(run),
        (run) => this.finish(run, 'stopped')
      );
      for (const threadId of subtree) {
        await erase(threadId);
        this.forgetThread(threadId);
      }
      for (const run of runs) {
        this.runs.delete(run.id);
        this.conversationIds.delete(run.id);
      }
      return { deleted: true };
    });
    for (const threadId of subtree) {
      this.deletions.set(threadId, deletion);
      abortHostThreadRuns(threadId, this.pendingAdmissions, this.runs.values());
    }
    this.admission = deletion.then(
      () => undefined,
      () => undefined
    );
    return deletion;
  }

  private forgetThread(threadId: string): void {
    for (const commandId of this.commands.forgetThread(threadId)) {
      this.conversationIds.delete(commandId);
    }
    this.conversationIds.delete(threadId);
    this.threads.delete(threadId);
    this.children.forget(threadId);
    this.presentations.forget(threadId);
    this.workspaces.forget(threadId);
    this.mcpInputs.forgetThread(threadId);
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
    return this.command('run/start', params, () =>
      this.admitRun('run/start', params, () => hostStartPosition(this.runs.values(), params))
    );
  }

  /** A new answer to an existing committed user message, on a sibling branch. */
  regenerateRun(params: HostParams<'run/regenerate'>): Promise<{ runId: string }> {
    return this.command('run/regenerate', params, () =>
      this.admitRun('run/regenerate', params, () =>
        hostRegeneratePosition(this.runs.values(), params)
      )
    );
  }

  /** One admission per new run; restart folds its committed branch the same way. */
  private async admitRun(
    method: 'run/start' | 'run/regenerate' | 'wake',
    params: HostParams<'run/start'> | HostParams<'run/regenerate'>,
    position: () => HostRunPosition
  ): Promise<{ runId: string }> {
    assertHostRunAdmissible(this.threads, this.runs.values(), this.conversationIds, params);
    const selected = position();
    const controller = new AbortController();
    this.pendingAdmissions.set(controller, params.threadId);
    let admission: HostRunAdmission | undefined;
    let release: (() => void) | undefined;
    try {
      admission = await acquireHostRunAdmission(this.platform, {
        ...(params.configuration ? { configuration: params.configuration } : {}),
        modelId: params.modelId,
        ...(method === 'wake' ? {} : { prompt: selected.prompt }),
        signal: controller.signal,
        threadId: params.threadId,
        ...this.workspaces.admissionBinding(params.threadId),
      });
      controller.signal.throwIfAborted();
      release = this.retainRun();
      const { run, started } = admittedHostRun(
        this.runs.values(),
        { ...params, method, runId: randomUUID() },
        hostDeliveryPosition(
          method,
          params.commandId,
          selected,
          this.children.pending(params.threadId, this.runs, admission.delegation, method !== 'wake')
        ),
        admission.snapshot,
        controller
      );
      run.admission = admission;
      if (this.conversationIds.has(run.id) || run.id === params.commandId) {
        throw new Error('Generated run collides with a committed conversation identity');
      }
      run.release = release;
      const result = { runId: run.id };
      await (method === 'wake'
        ? this.append(params.threadId, [started])
        : this.accept(params.threadId, method, params, result, [started]));
      this.children.recordDelivery(started.delivery);
      this.runs.set(run.id, run);
      recordHostConversationId(this.conversationIds, params.commandId);
      recordHostConversationId(this.conversationIds, run.id);
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
    const admission = await ensureHostRunAdmission(this.platform, run);
    const output = registered.delegation
      ? await this.children.delegate(
          { action, admission, input, persona: registered.delegation, run },
          this.childRunPort(run)
        )
      : await performHostToolEffect(run, action, registered, input, resumeData, {
          admit: (perform) => this.admit(run.threadId, perform, run.controller.signal),
          append: (events, durability, beforePublish) =>
            this.append(run.threadId, events, durability, beforePublish),
          fold: (row) => this.fold(row),
          mcpInputs: this.mcpInputs,
          retired: () => this.closing || this.deletions.has(run.threadId),
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

  /** BST-1932: HostChildRuns orchestrates a delegation; Core lends its sole writer and loop. */
  private childRunPort(run: Run): HostChildRunPort {
    return {
      commit: async ({ child, items, threadId }) => {
        await this.appendAcross(items, 'full');
        this.threads.add(threadId);
        this.runs.set(child.id, child);
        recordHostConversationId(this.conversationIds, threadId);
        recordHostConversationId(this.conversationIds, child.id);
      },
      loop: (child, model) => this.loop(child, model),
      retainRun: this.retainRun,
      stop: (child, reason) => {
        if (!this.closing) {
          retainHostRunWork(run, this.stopChildRun(child, reason));
        }
      },
      taken: (id) => this.threads.has(id) || this.conversationIds.has(id),
    };
  }

  /** Mirrors run/stop for a child its parent no longer waits on. */
  private async stopChildRun(child: Run, reason: unknown): Promise<void> {
    child.stopped = true;
    child.controller.abort(reason);
    await joinHostRunOwner(child, (owned) => this.closeRunOwner(owned));
    await this.finish(child, 'stopped');
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

  private async loop(run: Run, model: LanguageModel): Promise<void> {
    let failed: string | undefined;
    let interrupted = false;
    let checkpointFailure: unknown;
    run.paused = false;
    const initialMessages = hostRunContext(this.runs, run);
    const ancestors = hostRunAncestors(this.runs, run);
    let recordedInputLength = initialMessages.length;
    let historyPrepared = false;
    try {
      const owner = await this.openRun(run);
      const admission = await ensureHostRunAdmission(this.platform, run);
      this.presentations.request(run, admission, this.runs.values());
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
            const interactions = hostStepInteractions(run, step.content);
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
            prepared = healInterruptedRunHistory(messages, ancestors, run.threadId);
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
        toolApproval: ({ toolCall }) => decideHostSdkApproval(run, this.platform, toolCall),
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
    await finishHostSdkLoop(run, this.closing, failed, interrupted, (outcome, detail) =>
      this.finish(run, outcome, detail)
    );
  }

  private run(threadId: string, runId: string): Run {
    const run = this.runs.get(runId);
    if (!run || run.threadId !== threadId) {
      throw new Error('Unknown run for this thread');
    }
    return run;
  }

  readMcpInput(input: HostParams<'mcp/input/read'>): Promise<HostResults['mcp/input/read']> {
    return this.mcpInputs.read(parseHostParams('mcp/input/read', input));
  }

  stageMcpInput(
    input: HostParams<'mcp/input/stage'>,
    client: HostMcpInputClient
  ): Promise<{ staged: true }> {
    const params = parseHostParams('mcp/input/stage', input);
    return this.admit(params.threadId, () => this.mcpInputs.stage(params, client));
  }

  settleMcpInput(
    input: HostParams<'mcp/input/settle'>,
    client: HostMcpInputClient
  ): Promise<HostResults['mcp/input/settle']> {
    const params = parseHostParams('mcp/input/settle', input);
    return this.admit(params.threadId, () => {
      this.mcpInputs.assertSender(params, client);
      return this.commands.perform('mcp/input/settle', params, () => {
        const run = this.run(params.threadId, params.runId);
        return this.mcpInputs.prepareSettlement(
          params,
          client,
          (event) =>
            this.accept(
              run.threadId,
              'mcp/input/settle',
              params,
              { accepted: true, status: 'accepted' },
              [event],
              this.foldRows,
              'full'
            ),
          (event) => this.append(run.threadId, [event], 'full', this.foldRows),
          (work) => retainHostRunWork(run, work)
        );
      });
    }).then(() => this.mcpInputs.result(params));
  }

  releaseMcpInputClient(client: HostMcpInputClient): void {
    this.mcpInputs.releaseClient(client);
  }

  respond(params: HostParams<'interaction/respond'>): Promise<{ accepted: true }> {
    return this.command('interaction/respond', params, () =>
      commitHostInteractionResponse(
        this.run(params.threadId, params.runId),
        this.platform,
        params,
        (event) =>
          this.accept(params.threadId, 'interaction/respond', params, { accepted: true }, [event]),
        () => this.continueRun(this.run(params.threadId, params.runId))
      )
    );
  }

  resume(params: HostParams<'interaction/resume'>): Promise<{ accepted: true }> {
    return this.command('interaction/resume', params, () =>
      commitHostInteractionResponse(
        this.run(params.threadId, params.runId),
        this.platform,
        params,
        (event) =>
          this.accept(params.threadId, 'interaction/resume', params, { accepted: true }, [event]),
        () => this.continueRun(this.run(params.threadId, params.runId))
      )
    );
  }

  private commitMessages(run: Run, messages: readonly ModelMessage[]): Promise<void> {
    return commitHostModelMessages(
      run,
      messages,
      (event) => this.append(run.threadId, [event]).then((rows) => rows[0]),
      () => this.store.syncBoundary(run.threadId),
      (row) => this.fold(row)
    );
  }

  private async finishApprovedCalls(run: Run): Promise<void> {
    await this.commitMessages(
      run,
      await finishApprovedHostResults(run, this.platform, (action, input, resumeData) =>
        this.dispatch(run, action, input, resumeData)
      )
    );
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
      const reason = new Error('Run stopped by user');
      run.stopped = true;
      run.controller.abort(reason);
      // Report section 4: a root Stop ends its turn's children, foreground and background.
      await joinAllHostWork(
        [
          joinHostRunOwner(run, (owned) => this.closeRunOwner(owned)),
          ...this.children
            .turnChildren(run, this.runs)
            .map((child) => this.stopChildRun(child, reason)),
        ],
        'Stop cleanup failed'
      );
      await this.finish(run, 'stopped');
    };
    return this.command(
      'run/stop',
      params,
      () =>
        acceptHostRunStop(
          this.run(params.threadId, params.runId),
          (result) => this.accept(params.threadId, 'run/stop', params, result, []),
          join
        ),
      async (result) => {
        await join();
        return result;
      }
    );
  }

  private openRun(run: Run): Promise<HostRunOwner | undefined> {
    run.owner ??= ensureHostRunAdmission(this.platform, run).then((admission) => {
      // BST-1932: Memory stays scoped to root threads; a child opens no run owner.
      const open = run.origin
        ? undefined
        : (admission.openRun ?? this.platform.openRun?.bind(this.platform));
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
    detail?: string,
    wakes = true
  ): Promise<void> {
    return finishHostRunWithProviderBilling(
      run,
      outcome,
      detail,
      () => this.closing,
      (owned) => this.closeRunOwner(owned),
      () => this.read(run.threadId, 0),
      (event, commit) =>
        this.append(run.threadId, [event], 'full', (rows) => {
          commit();
          for (const row of rows) {
            this.fold(row);
          }
        })
    ).then(() => {
      this.presentations.settle(run);
      const parent = this.children.backgroundParent(run) ?? (run.origin ? undefined : run.threadId);
      if (parent && wakes) {
        this.wake(parent);
      }
    });
  }

  /** B10/B14 (ADR-0010): an idle, unparked parent wakes once per batch of settled children. */
  private wake(threadId: string): void {
    if (this.closing || this.deletions.has(threadId) || !this.threads.has(threadId)) {
      return;
    }
    this.admit(threadId, async () => {
      const params = this.children.wakeParams(threadId, this.runs);
      if (params) {
        await this.admitRun('wake', params, () => hostStartPosition(this.runs.values(), params));
      }
    }).catch((cause: unknown) => reportHostChildWakeFailure(threadId, cause));
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
    const outcomes = await retireHostRuns(
      [...this.runs.values()],
      (owned) => this.closeRunOwner(owned),
      (owned) => this.finish(owned, 'interrupted', 'Host closed with a pending decision'),
      () => this.platform.close(),
      [...this.failedAdmissions.values()]
    );
    this.listeners.clear();
    reportRetiredHostOutcomes(outcomes);
  }
}
