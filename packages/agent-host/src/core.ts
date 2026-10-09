import { randomUUID } from 'node:crypto';
import type { BlobContent } from '@brainstrike/state-store';
import type { LanguageModel, ModelMessage } from 'ai';
import { acceptHostChildInput, takeHostChildInput } from './child-input.js';
import { HostContextCompactions } from './context-compaction.js';
import {
  type HostChildRunPort,
  HostChildRuns,
  hostDeliveryPosition,
  reportHostChildWakeFailure,
} from './core-child-runs.js';
import { hostMcpTaskOwner } from './core-mcp-owner.js';
import { readHostThreadMemory } from './core-memory-read.js';
import { reportRetiredHostOutcomes, retireHostCoreRuns } from './core-retirement.js';
import {
  type HostRunAction as Action,
  executeHostAction,
  type HostRunExecutionPorts,
  runHostSdkLoop,
} from './core-run-execution.js';
import {
  acceptHostRunStop,
  assertHostCommandAdmissible,
  joinHostRunOwner,
  queueHostAdmission,
  recoverHostRun,
  rejectHostRunAdmission,
  retainHostRunWork,
  steerHostRun,
  stopHostRunTree,
} from './core-run-lifecycle.js';
import {
  createHostRunContext,
  foldHostAcceptedCommand,
  foldHostInteraction,
  foldHostRunEffect,
  HostCommandLedger,
  type HostRunState as Run,
  recordHostConversationId,
} from './core-state.js';
import { deleteHostThread } from './core-thread-deletion.js';
import { readHostRow, readHostThreadHistory, storedHostEvent } from './event-storage.js';
import { beginHostRun, foldHostHookContextEvent, hostRunTerminalEvents } from './hook-context.js';
import { canonical, type Json, jsonValue } from './json-value.js';
import { HostLedgerProjection } from './ledger-projection.js';
import { HostMcpAppCalls } from './mcp-app-calls.js';
import { type HostMcpInputClient, HostMcpInputState } from './mcp-input-state.js';
import type { HostClientOrigin, HostPlatform, HostRunAdmission, HostRunOwner } from './ports.js';
import { HostProjectionRewrites } from './projection-rewrites.js';
import {
  type HostEvent,
  type HostLogRow,
  type HostParams,
  type HostResults,
  type HostRunTelemetry,
  parseHostParams,
} from './protocol.js';
import { finishHostRunWithProviderBilling } from './provider-billing-diagnostics.js';
import {
  acquireHostRunAdmission,
  bindHostRunAdmission,
  closeHostRunResources,
  ensureHostRunAdmission,
  hostMcpUnavailableEvents,
  hostRunCommandRequest,
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
  hostRunInput,
  hostStartCommandRecord,
  hostStartPosition,
} from './run-branch.js';

import {
  approveHostRunByPolicy,
  commitHostInteractionResponse,
  commitHostModelMessages,
  continueHostRun,
  startHostNextRun,
} from './run-continuation.js';
import { userRunVerdict } from './run-verdicts.js';
import { type HostEventStore, HostThreadCatalog } from './thread-catalog.js';
import { HostThreadPresentationState } from './thread-presentation-state.js';
import { HostThreadRewinds } from './thread-rewind.js';
import { HostToolRecords } from './tool-records.js';
import { revertHostRunEdits } from './workspace-edits.js';
import { HostThreadWorkspaceState } from './workspace-state.js';

export { jsonValue } from './json-value.js';

export type { HostEventStore } from './thread-catalog.js';

/** One writer, one admission queue, and one SDK loop per root run (ADR-0011/12/17). */
export class HostCore {
  private readonly commands = new HostCommandLedger();
  private readonly mcpInputs = new HostMcpInputState();
  /** An MCP App's own tool calls, decided under the thread's live policy and grants. */
  readonly mcpApps = new HostMcpAppCalls({
    assertAdmissible: (threadId) =>
      assertHostCommandAdmissible(
        threadId,
        this.closing,
        this.threads,
        this.deletions,
        this.failedAdmissions
      ),
    grants: (threadId) => this.children.grants(threadId),
    platform: () => this.platform,
    read: (threadId) => this.read(threadId, 0),
    rootThread: (threadId) => this.children.rootThread(threadId),
  });
  private readonly records = new HostToolRecords();
  private readonly compactions = new HostContextCompactions();
  private readonly rewrites = new HostProjectionRewrites();
  /** Cost views and the thread list: every committed row, folded once. */
  private readonly ledger = new HostLedgerProjection();
  private readonly threads = new Set<string>();
  private readonly catalog = new HostThreadCatalog();
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
  private readonly listeners = new Set<(row: HostLogRow, parentThreadId?: string) => void>();
  private readonly telemetryListeners = new Set<(telemetry: HostRunTelemetry) => void>();
  private readonly pendingAdmissions = new Map<AbortController, string>();
  private readonly failedAdmissions = new Map<string, unknown>();
  private readonly deletions = new Map<string, Promise<HostResults['thread/delete']>>();
  private admission: Promise<void> = Promise.resolve();
  private readonly rewinds = new HostThreadRewinds({
    accept: (threadId, method, params, result, events) =>
      this.accept(threadId, method, params, result, events, this.foldRows, 'full'),
    append: (threadId, events) => this.append(threadId, events, 'full', this.foldRows),
    command: (method, params, perform) => this.command(method, params, perform),
    owner: () => ({ pending: this.pendingAdmissions, platform: this.platform, runs: this.runs }),
  });
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
    await core.catalog.hydrate(store, core.threads, (row) => {
      core.ledger.apply(row);
      core.fold(row);
    });
    await core.rewinds.recover();
    // BST-1930 c3: Core owns its recovered MCP tasks before any run can discover tools.
    platform.attachMcpTaskOwner?.(hostMcpTaskOwner(core.executionPorts()));
    for (const run of core.runs.values()) {
      const recovery = recoverHostRun(run);
      if (recovery?.kind === 'finish') {
        // Q-2: a restart wakes no parent; results reach the next user turn.
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
    this.records.fold(row);
    this.compactions.fold(row);
    this.rewrites.fold(row);
    this.presentations.fold(row);
    this.workspaces.fold(row);
    this.rewinds.fold(row);
    const event = row.event;
    switch (event.type) {
      case 'command.accepted':
        foldHostAcceptedCommand(this.commands, this.runs, event, row.threadId);
        foldHostRunAdmission(this.admittedRuns, this.conversationIds, event);
        break;
      case 'run.started':
        // A child thread's runs share their root thread's grants (ADR-0010).
        foldHostStartedRun(
          this.admittedRuns,
          this.conversationIds,
          this.runs,
          row.threadId,
          event,
          this.children.grants(row.threadId),
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
      case 'hook.context':
        foldHostHookContextEvent(this.runs, event);
        break;
      default:
        foldHostRunEffect(this.runs, event, row.ts);
        break;
    }
    this.children.fold(row, this.runs);
  }

  private append(
    threadId: string,
    events: readonly HostEvent[],
    durability: 'normal' | 'full' = 'normal',
    beforePublish?: (rows: readonly HostLogRow[]) => void,
    /** Blobs an event names in `blobRefs` (storedHostEvent matches them per event). */
    referenced?: readonly BlobContent[]
  ): Promise<HostLogRow[]> {
    return this.appendAcross(
      events.map((event) => ({ event, threadId })),
      durability,
      beforePublish,
      referenced
    );
  }

  /** One StateStore transaction, possibly across threads (a parent and its new child). */
  private async appendAcross(
    items: readonly { readonly event: HostEvent; readonly threadId: string }[],
    durability: 'normal' | 'full' = 'normal',
    beforePublish?: (rows: readonly HostLogRow[]) => void,
    referenced?: readonly BlobContent[]
  ): Promise<HostLogRow[]> {
    const committed = await this.store.append(
      items.map(({ event, threadId }) => storedHostEvent(threadId, event, referenced)),
      undefined,
      durability
    );
    const rows = await Promise.all(committed.map((row) => readHostRow(this.store, row)));
    this.catalog.noteCommitted(rows);
    beforePublish?.(rows);
    for (const row of rows) {
      this.ledger.apply(row);
      for (const listener of this.listeners) {
        listener(row, this.children.parentOf(row.threadId));
      }
    }
    return rows;
  }

  onCommitted(listener: (row: HostLogRow, parentThreadId?: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A running tool's live telemetry, published to listeners and never committed. */
  onTelemetry(listener: (telemetry: HostRunTelemetry) => void): () => void {
    this.telemetryListeners.add(listener);
    return () => this.telemetryListeners.delete(listener);
  }

  /** Top-level threads with the facts Core already holds: presentation, store dates, damage, binding, latest run. */
  listThreads(): HostResults['thread/list']['threads'] {
    return this.children.topLevel(this.threads).map((threadId) => {
      const latestRun = this.ledger.readLatestRun(threadId);
      return {
        threadId,
        ...this.presentations.read(threadId),
        ...this.catalog.entry(threadId),
        ...this.workspaces.readBinding(this.threads, threadId),
        ...(latestRun ? { latestRun } : {}),
      };
    });
  }

  /** Every thread's runs and costed provider calls, folded from its committed log. */
  readLedger(): HostResults['ledger/read'] {
    return this.ledger.read();
  }

  /** BST-1932: a thread's direct child threads, in delegation order, with their origins. */
  listChildren(threadId: string): HostResults['thread/children']['children'] {
    return this.children.listed(threadId, this.threads, this.presentations, this.runs);
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
        const { closing, deletions, failedAdmissions, threads } = this;
        assertHostCommandAdmissible(threadId, closing, threads, deletions, failedAdmissions);
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

  /** Thread deletion queues behind admission and joins its runs (`core-thread-deletion.ts`). */
  deleteThread(params: { readonly threadId: string }): Promise<HostResults['thread/delete']> {
    const { admission, children, deletions, failedAdmissions, pendingAdmissions, runs } = this;
    return deleteHostThread(
      {
        admission,
        children,
        closeRunOwner: (run) => this.closeRunOwner(run),
        closing: () => this.closing,
        deletions,
        erase: this.store.deleteThread?.bind(this.store),
        failedAdmissions,
        finish: (run) => this.finish(run, 'stopped'),
        forgetRun: (run) => {
          this.runs.delete(run.id);
          this.conversationIds.delete(run.id);
        },
        forgetThread: async (threadId) => {
          this.forgetThread(threadId);
          await this.catalog.forget(threadId);
        },
        pendingAdmissions,
        queue: (tail) => {
          this.admission = tail;
        },
        runs,
        threads: this.threads,
      },
      params.threadId
    );
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
    this.records.forgetThread(threadId, this.platform);
    this.compactions.forgetThread(threadId);
    this.rewrites.forgetThread(threadId);
    this.rewinds.forgetThread(threadId);
    this.ledger.forget(threadId);
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

  startRun(params: HostParams<'run/start'>, origin?: HostClientOrigin): Promise<{ runId: string }> {
    const record = hostStartCommandRecord(params);
    return this.command('run/start', record, () =>
      this.admitRun(
        'run/start',
        params,
        origin,
        () => hostStartPosition(this.runs.values(), this.rewinds.position(params)),
        record
      )
    );
  }

  /** A new answer to an existing committed user message, on a sibling branch. */
  regenerateRun(
    params: HostParams<'run/regenerate'>,
    origin?: HostClientOrigin
  ): Promise<{ runId: string }> {
    return this.command('run/regenerate', params, () =>
      this.admitRun('run/regenerate', params, origin, () =>
        hostRegeneratePosition(this.runs.values(), params)
      )
    );
  }

  /** Memory readiness for the next run: read-only, never queued (`core-memory-read.ts`). */
  readThreadMemory(
    params: HostParams<'thread/memory/read'>,
    origin?: HostClientOrigin
  ): Promise<HostResults['thread/memory/read']> {
    const { children, deletions, platform, runs, threads, workspaces } = this;
    const context = { children, deletions, origin, runs, threads, workspaces };
    return readHostThreadMemory(platform, params, context);
  }

  /** One admission per new run; restart folds its committed branch the same way. */
  private async admitRun(
    method: 'run/start' | 'run/regenerate' | 'wake',
    params: HostParams<'run/start'> | HostParams<'run/regenerate'>,
    origin: HostClientOrigin | undefined,
    position: () => HostRunPosition,
    record: { readonly commandId: string } = params
  ): Promise<{ runId: string }> {
    this.catalog.assertRunnable(params.threadId);
    assertHostRunAdmissible(this.threads, this.runs.values(), this.conversationIds, params);
    const selected = position();
    const controller = new AbortController();
    this.pendingAdmissions.set(controller, params.threadId);
    let admission: HostRunAdmission | undefined;
    let release: (() => void) | undefined;
    // BST-1932: a child thread's run is admitted for its root, then narrowed.
    const root = this.children.rootThread(params.threadId);
    // Admission is for this run: platforms key its selection by the run's ID.
    const runId = randomUUID();
    try {
      const wake = method === 'wake' ? this.children.wakeSelection(params, this.runs) : undefined;
      admission = await acquireHostRunAdmission(this.platform, {
        ...hostRunCommandRequest(
          { ...params, runId, threadId: root },
          origin,
          wake ? undefined : selected.prompt,
          controller.signal,
          wake
        ),
        ...this.workspaces.admissionBinding(root),
      });
      const child = await this.children.followUp(
        params.threadId,
        admission,
        this.runs,
        this.platform
      );
      admission = child.admission;
      controller.signal.throwIfAborted();
      release = this.retainRun();
      const { run, started } = admittedHostRun(
        this.runs.values(),
        {
          ...params,
          input: hostRunInput(params.configuration, origin),
          method,
          runId,
        },
        hostDeliveryPosition(
          method,
          params.commandId,
          selected,
          this.children.pending(params.threadId, this.runs, admission.delegation, method !== 'wake')
        ),
        this.children.grants(root),
        admission.snapshot,
        controller
      );
      await bindHostRunAdmission(this.platform, run, admission);
      child.adopt(run);
      if (this.conversationIds.has(run.id) || run.id === params.commandId) {
        throw new Error('Generated run collides with a committed conversation identity');
      }
      run.release = release;
      const result = { runId: run.id };
      const unavailable = hostMcpUnavailableEvents(admission, run.id);
      // A wake has no client command: its run.started records the delivery it answers.
      await (method === 'wake'
        ? this.append(params.threadId, [started, ...unavailable])
        : this.accept(params.threadId, method, record, result, [started, ...unavailable]));
      this.children.recordDelivery(started.delivery);
      this.runs.set(run.id, run);
      recordHostConversationId(this.conversationIds, params.commandId);
      recordHostConversationId(this.conversationIds, run.id);
      run.task = beginHostRun(run, admission, {
        commit: (events) => this.append(run.threadId, events, 'full', this.foldRows),
        fail: (detail) => this.finish(run, 'failed', detail),
        loop: (model) => this.loop(run, model),
      });
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

  /** Core's single-writer seams for the moved run execution path. */
  private executionPorts(): HostRunExecutionPorts {
    return {
      admit: (threadId, perform, signal) => this.admit(threadId, perform, signal),
      append: (threadId, events, durability, beforePublish, referenced) =>
        this.append(threadId, events, durability, beforePublish, referenced),
      armDeadline: (run) => this.children.armDeadline(run),
      closing: () => this.closing,
      commitMessages: (run, messages) => this.commitMessages(run, messages),
      compactions: this.compactions,
      delegate: async (run, action, input) =>
        this.children.delegate(
          { action, admission: await ensureHostRunAdmission(this.platform, run), input, run },
          this.childRunPort(run, action)
        ),
      dispatch: (run, action, input) => this.dispatch(run, action, input),
      finish: (run, outcome, detail) => this.finish(run, outcome, detail),
      fold: (row) => this.fold(row),
      foldRows: this.foldRows,
      mcpInputs: this.mcpInputs,
      openRun: (run) => this.openRun(run),
      platform: this.platform,
      records: this.records,
      retired: (threadId) => this.closing || this.deletions.has(threadId),
      rewrites: this.rewrites,
      runs: this.runs,
      syncBoundary: (threadId) => this.store.syncBoundary(threadId),
      telemetry: (telemetry) => {
        for (const listener of this.telemetryListeners) {
          listener(telemetry);
        }
      },
    };
  }

  /** BST-1932: HostChildRuns orchestrates a delegation; Core lends its sole writer and loop. */
  private childRunPort(run: Run, action: Action): HostChildRunPort {
    return {
      commit: async ({ child, items, threadId }) => {
        await this.appendAcross(items, 'full');
        this.threads.add(threadId);
        this.runs.set(child.id, child);
        recordHostConversationId(this.conversationIds, threadId);
        recordHostConversationId(this.conversationIds, child.id);
      },
      commitEffect: () => this.append(run.threadId, [action]).then(() => undefined),
      loop: (child, model) => this.loop(child, model),
      policy: async (threadId) => await this.platform.readPermissionPolicy(threadId),
      retainRun: this.retainRun,
      stop: (child, reason) => {
        if (!this.closing) {
          retainHostRunWork(run, this.stopRun(child, reason));
        }
      },
      taken: (id) => this.threads.has(id) || this.conversationIds.has(id),
    };
  }

  /** A user stop of one run: abort it, join its owner, then commit `stopped`. */
  private async stopRun(run: Run, reason: unknown): Promise<void> {
    run.stopped = true;
    run.controller.abort(reason);
    await joinHostRunOwner(run, (owned) => this.closeRunOwner(owned));
    await this.finish(run, 'stopped');
  }

  private dispatch(
    run: Run,
    action: Action,
    input: unknown,
    resumeData?: unknown
  ): Promise<unknown> {
    const effect = executeHostAction(this.executionPorts(), run, action, input, resumeData);
    run.effects.add(effect);
    const joined = (): void => {
      run.effects.delete(effect);
    };
    effect.then(joined, joined);
    return effect;
  }

  private async loop(run: Run, model: LanguageModel): Promise<void> {
    await runHostSdkLoop(this.executionPorts(), run, model);
    // A call decided before a tree grant can pause after it: the grant answers it too.
    if (run.paused && !run.terminal) {
      this.releaseTreeGrants(run.threadId);
    }
  }

  /** ADR-0010: every pending approval of the tree that the root's policy and grants now allow. */
  private releaseTreeGrants(threadId: string): void {
    this.children.releaseGranted(threadId, this.runs, (sibling, interactionId) =>
      this.admit(sibling.threadId, () =>
        approveHostRunByPolicy(
          sibling,
          this.platform,
          interactionId,
          (events) => this.append(sibling.threadId, events),
          () => this.continueRun(sibling)
        )
      )
    );
  }

  private run(threadId: string, runId: string): Run {
    const run = this.runs.get(runId);
    if (!run || run.threadId !== threadId) {
      throw new Error('Unknown run for this thread');
    }
    return run;
  }

  /** Restore a finished run's edits to their baselines; the outcome joins the thread's log. */
  revertCheckpoint(
    params: HostParams<'checkpoint/revert'>
  ): Promise<HostResults['checkpoint/revert']> {
    const method = 'checkpoint/revert';
    return this.command(method, params, async () => {
      this.run(params.threadId, params.runId);
      const { events, result } = await revertHostRunEdits(this.records.edits, params, {
        pending: this.pendingAdmissions,
        platform: this.platform,
        runs: this.runs.values(),
        storeRoot: this.store.root,
      });
      await this.accept(params.threadId, method, params, result, events, this.foldRows, 'full');
      return result;
    });
  }

  /** Restore to before a message (`thread-rewind.ts`): preview, rewind, and redo. */
  previewRewind(params: HostParams<'thread/rewind/preview'>) {
    return this.rewinds.preview(params);
  }

  rewind(params: HostParams<'thread/rewind'>): Promise<HostResults['thread/rewind']> {
    return this.rewinds.rewind(params);
  }

  redoRewind(params: HostParams<'thread/rewind/redo'>): Promise<HostResults['thread/rewind/redo']> {
    return this.rewinds.redo(params);
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
    return this.answer('interaction/respond', params);
  }

  resume(params: HostParams<'interaction/resume'>): Promise<{ accepted: true }> {
    return this.answer('interaction/resume', params);
  }

  private answer(
    method: 'interaction/respond' | 'interaction/resume',
    params: HostParams<'interaction/respond'> | HostParams<'interaction/resume'>
  ): Promise<{ accepted: true }> {
    const run = () => this.run(params.threadId, params.runId);
    return this.command(method, params, async () => {
      const answered = await commitHostInteractionResponse(
        run(),
        this.platform,
        params,
        (events) => this.accept(params.threadId, method, params, { accepted: true }, events),
        () => this.continueRun(run())
      );
      this.releaseTreeGrants(params.threadId);
      return answered;
    });
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

  /** Run the approved calls once every decision is answered, then go on (run-continuation). */
  private continueRun(run: Run): Promise<void> {
    return continueHostRun(run, {
      commitMessages: (messages) => this.commitMessages(run, messages),
      dispatch: (action, input, resumeData) => this.dispatch(run, action, input, resumeData),
      finish: (outcome, detail) => this.finish(run, outcome, detail),
      loop: (model) => this.loop(run, model),
      openRun: () => this.openRun(run),
      platform: this.platform,
      startNextRun: (params) => this.startNextRun(params, run.input?.origin),
    });
  }

  recordVerdict(params: HostParams<'run/verdict'>): Promise<{ accepted: true }> {
    return this.command('run/verdict', params, async () => {
      const event = userRunVerdict(this.runs.get(params.runId)?.threadId, params);
      await this.accept(params.threadId, 'run/verdict', params, { accepted: true }, [event]);
      return { accepted: true } as const;
    });
  }

  /** BST-1932 (AT-09): a running child's active run ends after its step; the input runs next. */
  input(params: HostParams<'run/input'>): Promise<{ accepted: true }> {
    return this.command('run/input', params, () =>
      acceptHostChildInput(
        this.run(params.threadId, params.runId),
        this.children.isChild(params.threadId),
        params,
        () => this.accept(params.threadId, 'run/input', params, { accepted: true }, [])
      )
    );
  }

  steer(params: HostParams<'run/steer'>): Promise<{ outcome: 'steering' | 'already-terminal' }> {
    return this.command('run/steer', params, () =>
      steerHostRun(this.run(params.threadId, params.runId), (result) =>
        this.accept(params.threadId, 'run/steer', params, result, [])
      )
    );
  }

  stop(params: HostParams<'run/stop'>): Promise<{ outcome: 'stopped' | 'already-terminal' }> {
    const join = (): Promise<void> => {
      const run = this.run(params.threadId, params.runId);
      // BST-1932: a root Stop ends its turn's children, foreground and background.
      const stopped = [run, ...this.children.turnChildren(run, this.runs)];
      return stopHostRunTree(stopped, (owned, reason) => this.stopRun(owned, reason));
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
      return open?.({
        ...createHostRunContext(run, (threadId, events) => this.append(threadId, events, 'full')),
        ...(admission.workingMemory === false ? { workingMemory: false as const } : {}),
      });
    });
    return run.owner;
  }

  private closeRunOwner(run: Run): Promise<void> {
    run.ownerClose ??= closeHostRunResources(run);
    return run.ownerClose;
  }

  private startNextRun(
    params: HostParams<'run/start'>,
    origin: HostClientOrigin | undefined,
    refused?: Error
  ): Promise<boolean> {
    return startHostNextRun(
      this.runs.values(),
      params,
      () => this.startRun(params, origin),
      (runId, events) =>
        this.accept(params.threadId, 'run/start', params, { runId }, events, this.foldRows),
      refused
    );
  }

  private finish(
    run: Run,
    outcome: Extract<HostEvent, { type: 'run.finished' }>['outcome'],
    detail?: string,
    wakes = true
  ): Promise<void> {
    // A completed run asks for its thread's title while its admission is still live.
    const titling =
      outcome === 'completed' ? this.presentations.request(run, this.runs.values()) : undefined;
    return finishHostRunWithProviderBilling(
      run,
      outcome,
      detail,
      () => this.closing,
      (owned) =>
        titling ? titling.then(() => this.closeRunOwner(owned)) : this.closeRunOwner(owned),
      () => this.read(run.threadId, 0),
      async (event, commit) =>
        this.append(run.threadId, await hostRunTerminalEvents(run, event), 'full', (rows) => {
          commit();
          this.foldRows(rows);
        })
    ).then(async () => {
      this.presentations.settle(run);
      const parent = this.children.deliveryParent(run) ?? (run.origin ? undefined : run.threadId);
      // BST-1932: a child's human input runs next; only that run reports to the parent.
      const open = wakes && !(this.closing || this.deletions.has(run.threadId));
      const input = takeHostChildInput(run, outcome, open);
      const next =
        input && (await this.startNextRun(input.params, run.input?.origin, input.refused));
      if (parent && wakes && !next && !(this.closing || this.deletions.has(parent))) {
        this.wake(parent);
      }
    });
  }

  /** B10/B14 (ADR-0010): an idle, unparked parent wakes once per batch of settled children. */
  private wake(threadId: string): void {
    this.admit(threadId, async () => {
      const wake = this.children.wakeParams(threadId, this.runs);
      if (wake) {
        await this.admitRun('wake', wake.params, wake.origin, () =>
          hostStartPosition(this.runs.values(), this.rewinds.position(wake.params))
        );
      }
    }).catch((cause: unknown) => reportHostChildWakeFailure(threadId, cause));
  }

  close(): Promise<void> {
    this.closeTask ??= this.closeOwned();
    return this.closeTask;
  }

  private async closeOwned(): Promise<void> {
    this.closing = true;
    const outcomes = await retireHostCoreRuns({
      admission: () => this.admission,
      closeOwner: (owned) => this.closeRunOwner(owned),
      closePlatform: () => this.platform.close(),
      failedAdmissions: () => [...this.failedAdmissions.values()],
      finish: (owned) => this.finish(owned, 'interrupted', 'Host closed with a pending decision'),
      pendingAdmissions: this.pendingAdmissions.keys(),
      runs: () => [...this.runs.values()],
    });
    this.listeners.clear();
    this.telemetryListeners.clear();
    reportRetiredHostOutcomes(outcomes);
  }
}
