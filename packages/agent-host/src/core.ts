import { randomUUID } from 'node:crypto';
import type { BlobContent, StateStore } from '@brainstrike/state-store';
import type { LanguageModel, ModelMessage } from 'ai';
import { acceptHostChildInput, takeHostChildInput } from './child-input.js';
import { HostContextCompactions } from './context-compaction.js';
import {
  type HostChildRunPort,
  HostChildRuns,
  hostDeliveryPosition,
  reportHostChildWakeFailure,
} from './core-child-runs.js';
import { reportRetiredHostOutcomes, retireHostCoreRuns } from './core-retirement.js';
import {
  type HostRunAction as Action,
  executeHostAction,
  type HostRunExecutionPorts,
  runHostSdkLoop,
} from './core-run-execution.js';
import {
  abortHostThreadRuns,
  acceptHostRunStop,
  assertHostAdmissionCleanup,
  assertHostCommandAdmissible,
  joinHostRunOwner,
  joinHostThreadDeletion,
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
  type HostThreadGrants,
  hasHostInteractionResponse,
  type HostRunState as Run,
  recordHostConversationId,
} from './core-state.js';
import { readHostRow, readHostThreadHistory, storedHostEvent } from './event-storage.js';
import { beginHostRun, foldHostHookContextEvent, hostRunTerminalEvents } from './hook-context.js';
import type { HostHookTrustStore } from './hook-trust.js';
import { canonical, type Json, jsonValue } from './json-value.js';
import { type HostMcpInputClient, HostMcpInputState } from './mcp-input-state.js';
import type { HostClientOrigin, HostPlatform, HostRunAdmission, HostRunOwner } from './ports.js';
import { HostProjectionRewrites } from './projection-rewrites.js';
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
  bindHostRunAdmission,
  closeHostRunResources,
  ensureHostRunAdmission,
  hostLegacyObservationEvents,
  hostMcpUnavailableEvents,
  hostRunCommandRequest,
  isHostLegacyObservationNotice,
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
  hostStartCommandRecord,
  hostStartPosition,
} from './run-branch.js';

import {
  approvedHostPlan,
  approvedHostPlanRunParams,
  approveHostRunByPolicy,
  commitHostInteractionResponse,
  commitHostModelMessages,
  createHostApprovalResponses,
  finishApprovedHostResults,
  hostContinuationFailure,
  startHostNextRun,
} from './run-continuation.js';
import { userRunVerdict } from './run-verdicts.js';
import { HostThreadPresentationState } from './thread-presentation-state.js';
import { HostToolRecords } from './tool-records.js';
import { revertHostRunEdits } from './workspace-edits.js';
import { HostThreadWorkspaceState } from './workspace-state.js';

export { jsonValue } from './json-value.js';

export type HostEventStore = HostHookTrustStore &
  Pick<StateStore, 'append' | 'read' | 'root' | 'syncBoundary' | 'threads'> & {
    readonly deleteThread?: StateStore['deleteThread'];
  };

/** One writer, one admission queue, and one SDK loop per root run (ADR-0011/12/17). */
export class HostCore {
  private readonly commands = new HostCommandLedger();
  private readonly mcpInputs = new HostMcpInputState();
  private readonly records = new HostToolRecords();
  private readonly compactions = new HostContextCompactions();
  private readonly rewrites = new HostProjectionRewrites();
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
  /** Each thread's approval grants, for this process only; replay never restores them. */
  private readonly grants = new Map<string, HostThreadGrants>();
  private readonly admittedRuns = new Map<string, HostRunAdmissionCommand>();
  private readonly conversationIds = new Set<string>();
  private readonly listeners = new Set<(row: HostLogRow) => void>();
  private readonly pendingAdmissions = new Map<AbortController, string>();
  private readonly failedAdmissions = new Map<string, unknown>();
  private readonly deletions = new Map<string, Promise<{ deleted: true }>>();
  private admission: Promise<void> = Promise.resolve();
  /** Gap 17: the root's log holds the legacy-observations notice. */
  private legacyObservationsNoticed = false;
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
    const event = row.event;
    this.legacyObservationsNoticed ||= isHostLegacyObservationNotice(event);
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
          this.threadGrants(this.children.rootThread(row.threadId)),
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

  /** BST-1932: a thread's direct child threads, in delegation order, with their origins. */
  listChildren(threadId: string): HostResults['thread/children']['children'] {
    return this.children.listed(threadId, this.threads, this.presentations);
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
    // BST-1932: a thread's child threads are deleted with it, through this same path.
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
    this.records.forgetThread(threadId, this.platform);
    this.compactions.forgetThread(threadId);
    this.rewrites.forgetThread(threadId);
    this.grants.delete(threadId);
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
        () => hostStartPosition(this.runs.values(), params),
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

  /** One admission per new run; restart folds its committed branch the same way. */
  private async admitRun(
    method: 'run/start' | 'run/regenerate' | 'wake',
    params: HostParams<'run/start'> | HostParams<'run/regenerate'>,
    origin: HostClientOrigin | undefined,
    position: () => HostRunPosition,
    record: { readonly commandId: string } = params
  ): Promise<{ runId: string }> {
    assertHostRunAdmissible(this.threads, this.runs.values(), this.conversationIds, params);
    const selected = position();
    const controller = new AbortController();
    this.pendingAdmissions.set(controller, params.threadId);
    let admission: HostRunAdmission | undefined;
    let release: (() => void) | undefined;
    // BST-1932: a child thread's run is admitted for its root, then narrowed.
    const root = this.children.rootThread(params.threadId);
    try {
      const wake = method === 'wake' ? this.children.wakeSelection(params, this.runs) : undefined;
      admission = await acquireHostRunAdmission(this.platform, {
        ...hostRunCommandRequest(
          { ...params, threadId: root },
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
          input: {
            ...(params.configuration ? { configuration: params.configuration } : {}),
            ...(origin ? { origin } : {}),
          },
          method,
          runId: randomUUID(),
        },
        hostDeliveryPosition(
          method,
          params.commandId,
          selected,
          this.children.pending(params.threadId, this.runs, admission.delegation, method !== 'wake')
        ),
        this.threadGrants(root),
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
      // Serialized admission makes the legacy notice's check-then-append commit it once.
      const legacy = hostLegacyObservationEvents(admission, run.id, this.legacyObservationsNoticed);
      const notices = [...hostMcpUnavailableEvents(admission, run.id), ...legacy];
      // A wake has no client command: its run.started records the delivery it answers.
      await (method === 'wake'
        ? this.append(params.threadId, [started, ...notices])
        : this.accept(params.threadId, method, record, result, [started, ...notices]));
      this.legacyObservationsNoticed ||= admission.legacyObservationsWithheld === true;
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

  private loop(run: Run, model: LanguageModel): Promise<void> {
    return runHostSdkLoop(this.executionPorts(), run, model);
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

  private threadGrants(threadId: string): HostThreadGrants {
    let grants = this.grants.get(threadId);
    if (!grants) {
      grants = { categories: new Set(), tools: new Set() };
      this.grants.set(threadId, grants);
    }
    return grants;
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
      // ADR-0010: every pending approval of the tree the root's policy now allows.
      this.children.releaseGranted(params.threadId, this.runs, (sibling, interactionId) =>
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
      const plan = approvedHostPlan(run);
      if (plan) {
        await this.finish(run, 'completed');
        await this.startNextRun(approvedHostPlanRunParams(run, plan), run.input?.origin);
        return;
      }
      if (run.steps >= admission.snapshot.maxSteps) {
        await this.finishApprovedCalls(run);
        return;
      }
      await this.loop(run, admission.model);
    } catch (cause) {
      if (run.completion) {
        throw cause;
      }
      const failed = hostContinuationFailure(run, cause);
      await this.finish(run, failed.outcome, failed.detail);
    }
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
          hostStartPosition(this.runs.values(), wake.params)
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
    reportRetiredHostOutcomes(outcomes);
  }
}
