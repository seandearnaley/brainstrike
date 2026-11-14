import { randomUUID } from 'node:crypto';
import type { BlobContent } from '@brainstrike/state-store';
import type { LanguageModel, ModelMessage } from 'ai';
import { endHostAbandonedTurns, type HostForkPoint, hostRunFork } from './abandoned-turns.ts';
import { admitHostChildModel } from './child-model-admission.ts';
import { HostContextCompactions } from './context-compaction.ts';
import { hostCanvases } from './core-canvases.ts';
import { type HostChildRunPort, HostChildRuns } from './core-child-runs.ts';
import { HostIdleWorktreeNotices } from './core-idle-worktrees.ts';
import { hostMcpTaskOwner } from './core-mcp-owner.ts';
import { readHostThreadMemory } from './core-memory-read.ts';
import { reportRetiredHostOutcomes, retireHostCoreRuns } from './core-retirement.ts';
import { HostRunEnds } from './core-run-end.ts';
import {
  type HostRunAction as Action,
  executeHostAction,
  type HostRunExecutionPorts,
  runHostSdkLoop,
} from './core-run-execution.ts';
import {
  acceptHostRunStop,
  assertHostCommandAdmissible,
  hostRunSettlementFailed,
  joinHostRunOwner,
  queueHostAdmission,
  recoverHostRuns,
  rejectHostRunAdmission,
  retainHostRunWork,
  stopHostRunOutsideQueue,
  stopHostRunTree,
} from './core-run-lifecycle.ts';
import {
  foldHostAcceptedCommand,
  HostCommandLedger,
  HostRunMap,
  type HostRunState as Run,
  recordHostConversationId,
} from './core-state.ts';
import { deleteHostThread } from './core-thread-deletion.ts';
import { foldedThreadReads } from './core-thread-reads.ts';
import { nodeHostRowReader, readHostRow, storedHostEvent } from './event-storage.ts';
import { beginHostRun } from './hook-context.ts';
import { type Json, jsonValue } from './json-value.ts';
import { HostLogProjections } from './log-projections.ts';
import { HostMcpAppCalls } from './mcp-app-calls.ts';
import { type HostMcpInputClient, HostMcpInputState } from './mcp-input-state.ts';
import type { HostClientOrigin, HostPlatform, HostRunAdmission, HostRunOwner } from './ports.ts';
import { HostProjectionRewrites } from './projection-rewrites.ts';
import {
  type HostEvent,
  type HostLogRow,
  type HostParams,
  type HostResults,
  type HostRunTelemetry,
  parseHostParams,
} from './protocol.ts';
import { HostPublishedRows, type HostRowListener } from './published-rows.ts';
import {
  acquireHostRunAdmission,
  bindHostRunAdmission,
  closeHostRunResources,
  ensureHostRunAdmission,
  hostMcpUnavailableEvents,
  hostReferencedFileEvents,
  hostRunCommandRequest,
  openHostRunOwner,
} from './run-admission.ts';
import {
  admittedHostRun,
  assertHostAttachments,
  assertHostRunAdmissible,
  foldHostRunAdmission,
  foldHostRunEvent,
  foldHostStartedRun,
  type HostRunAdmissionCommand,
  type HostRunPosition,
  hostRegeneratePosition,
  hostRunInput,
  hostStartCommandRecord,
  hostStartPosition,
} from './run-branch.ts';
import {
  approveHostRunByPolicy,
  commitHostInteractionResponse,
  commitHostModelMessages,
  continueHostRun,
  type HostNextRun,
  hostCarriedStartPosition,
  hostInteractionPreview,
  startHostNextRun,
} from './run-continuation.ts';
import { userRunVerdict } from './run-verdicts.ts';
import { HostTelemetryReplay } from './telemetry-replay.ts';
import { type HostEventStore, HostThreadCatalog } from './thread-catalog.ts';
import { HostThreadListing } from './thread-listing.ts';
import { HostThreadPresentationState } from './thread-presentation-state.ts';
import { HostThreadRewinds } from './thread-rewind.ts';
import { bindHostScratch, turnHostScratchIntoProject } from './thread-scratch.ts';
import { HostThreadSelections } from './thread-selection-state.ts';
import { HostThreadTrees } from './thread-summary.ts';
import { HostToolRecords } from './tool-records.ts';
import { revertHostRunEdits } from './workspace-edits.ts';
import { HostThreadWorkspaceState, type HostWorktreeEntry } from './workspace-state.ts';
import { hostWorktreeEntry } from './worktree-binding.ts';

export type { HostEventStore } from './thread-catalog.ts';

/** What Core is opened over: its store, platform and run retention. */
type HostCoreOwners = [store: HostEventStore, platform: HostPlatform, retainRun: () => () => void];
/** One writer, one admission queue, and one SDK loop per root run (ADR-0011/12/17). */
export class HostCore {
  private readonly commands = new HostCommandLedger();
  private readonly mcpInputs = new HostMcpInputState();
  /** An MCP App's own tool calls, decided under the thread's live policy and grants. */
  readonly mcpApps = new HostMcpAppCalls({
    assertAdmissible: (threadId) => this.assertAdmissible(threadId),
    grants: (threadId) => this.children.grants(threadId),
    platform: () => this.platform,
    read: (threadId) => this.read(threadId, 0),
    rootThread: (threadId) => this.children.rootThread(threadId),
  });
  private readonly records = new HostToolRecords();
  private readonly compactions = new HostContextCompactions();
  private readonly rewrites = new HostProjectionRewrites();
  /** Cost views and the thread list: every committed row, folded once. */
  private readonly projections = new HostLogProjections();
  private readonly threads = new Set<string>();
  private readonly catalog = new HostThreadCatalog();
  private readonly presentations = new HostThreadPresentationState({
    admit: (threadId, perform) => this.admit(threadId, perform),
    append: async (threadId, events) => {
      await this.append(threadId, events, 'normal', this.foldRows);
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
  /** ADR-0019: each thread's run selection, folded from every committed row like the ledger. */
  readonly selections = new HostThreadSelections({
    accept: (threadId, method, params, result, events) =>
      this.accept(threadId, method, params, result, events),
    command: (method, params, perform) => this.command(method, params, perform),
    threads: this.threads,
  });
  private readonly runs = new HostRunMap();
  private readonly children = new HostChildRuns();
  /** BST-1932: each thread's children, its summary and its delegated tree (`thread/tree`). */
  readonly trees = new HostThreadTrees(this.projections, this.catalog, this.children, {
    presentations: this.presentations,
    runs: this.runs,
    threads: this.threads,
  });
  private readonly admittedRuns = new Map<string, HostRunAdmissionCommand>();
  private readonly conversationIds = new Set<string>();
  readonly published = new HostPublishedRows((threadId, fromSeq) => this.read(threadId, fromSeq));
  /** Live telemetry: its listeners, and the replay a late subscriber receives. */
  readonly liveTelemetry = new HostTelemetryReplay();
  private readonly pendingAdmissions = new Map<AbortController, string>();
  private readonly failedAdmissions = new Map<string, unknown>();
  private readonly deletions = new Map<string, Promise<HostResults['thread/delete']>>();
  private admission: Promise<void> = Promise.resolve();
  /** A run's end: its terminal commit, memory settlement, then the next run or wake. */
  private readonly ends = new HostRunEnds({
    admit: (threadId, perform) => this.admit(threadId, perform),
    admitWake: (method, params, origin, record) => {
      const position = () => hostStartPosition(this.runs.values(), params);
      return this.admitRun(method, params, origin, position, record);
    },
    appendTerminal: (items, beforePublish) => this.appendAcross(items, 'full', beforePublish),
    children: this.children,
    closeOwner: (run) => this.closeRunOwner(run),
    closing: () => this.closing,
    commitStart: (record, runId, events) =>
      this.accept(record.threadId, 'run/start', record, { runId }, events, this.foldRows),
    deletions: this.deletions,
    foldRows: (rows) => this.foldRows(rows),
    post: (threadId, notice) => this.notify(threadId, { notice, type: 'notice.posted' }),
    presentations: this.presentations,
    runs: () => this.runs,
    selections: this.selections,
    startNextRun: (next, origin) => this.startNextRun(next, origin),
    tip: (threadId) => this.rewinds.tip(threadId),
  });
  /** The Artifacts gallery's canvas reads, across every thread Core holds. */
  readonly canvases = hostCanvases(this.records, this.children, this.threads);
  /** Restore to before a message (`thread-rewind.ts`): preview, rewind, and redo. */
  readonly rewinds = new HostThreadRewinds({
    accept: (threadId, method, params, result, events) =>
      this.accept(threadId, method, params, result, events, this.foldRows, 'full'),
    append: (threadId, events) => this.append(threadId, events, 'full', this.foldRows),
    command: (method, params, perform, fork) => this.settledCommand(method, params, perform, fork),
    owner: () => ({ pending: this.pendingAdmissions, platform: this.platform, runs: this.runs }),
  });
  /** A notice no person typed, queued: a thread being deleted or a closing host takes none. */
  private readonly notify = (threadId: string, event: HostEvent): Promise<HostLogRow[]> =>
    this.admit(threadId, () => this.append(threadId, [event], 'normal', this.foldRows));
  private readonly idleWorktrees = new HostIdleWorktreeNotices(this.notify, () => this.runs);
  private closing = false;
  private closeTask?: Promise<void>;
  readonly listing = new HostThreadListing();
  /** Settles once Core has folded its log and recovered its runs; its owners see a failure. */
  readonly hydrated: Promise<void>;

  readonly store: HostEventStore;
  private readonly platform: HostPlatform;
  private readonly retainRun: () => () => void;

  private constructor(...[store, platform, retainRun]: HostCoreOwners) {
    this.store = store;
    this.platform = platform;
    this.retainRun = retainRun;
    this.hydrated = this.listing.start(store, () => this.hydrate());
  }

  /**
   * Core before its log is folded: the workspace services and the thread list serve at once,
   * while thread reads and commands wait on `hydrated`. The owner joins or observes `hydrated`;
   * `close` waits for it.
   */
  static start(...owners: HostCoreOwners): HostCore {
    const core = new HostCore(...owners);
    // ADR-0029: the platform's workspace services ask Core which runs are live, once it knows.
    owners[1].attachThreadReads?.(foldedThreadReads(core));
    return core;
  }

  /** Core with its log folded and its runs recovered. */
  static async open(...owners: HostCoreOwners): Promise<HostCore> {
    const core = HostCore.start(...owners);
    await core.hydrated;
    return core;
  }

  private async hydrate(): Promise<void> {
    await this.catalog.hydrate(this.store, nodeHostRowReader(this.store), this.threads, (row) => {
      this.projections.apply(row);
      this.selections.fold(row);
      this.fold(row);
    });
    await this.rewinds.recover();
    // BST-1930 c3: Core owns its recovered MCP tasks before any run can discover tools.
    this.platform.attachMcpTaskOwner?.(hostMcpTaskOwner(this.executionPorts()));
    this.ends.exits.listen(this.platform);
    this.idleWorktrees.listen(this.platform);
    await recoverHostRuns(this.runs.values(), {
      continueRun: (run) => this.continueRun(run),
      finish: (run, outcome, detail) => this.ends.finish(run, outcome, detail, true),
      retainRun: this.retainRun,
    });
  }

  private fold(row: HostLogRow): void {
    this.mcpInputs.fold(row);
    this.records.fold(row);
    this.compactions.fold(row);
    this.rewrites.fold(row);
    this.presentations.fold(row);
    this.workspaces.fold(row, this.runs);
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
      default:
        foldHostRunEvent(this.runs, event, row.ts);
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
      durability
    );
    return this.published.fold(committed, async () => {
      const rows = await Promise.all(committed.map((row) => readHostRow(this.store, row)));
      this.catalog.noteCommitted(rows);
      beforePublish?.(rows);
      for (const row of rows) {
        this.projections.apply(row);
        this.selections.fold(row);
        this.liveTelemetry.committed(row);
        this.published.publish(row, this.children.parentOf(row.threadId));
      }
      return rows;
    });
  }

  readonly onCommitted = (listener: HostRowListener): (() => void) =>
    this.published.subscribe(listener);

  /** A running tool's live telemetry, published to listeners and never committed. */
  readonly onTelemetry = (listener: (telemetry: HostRunTelemetry) => void): (() => void) =>
    this.liveTelemetry.subscribe(listener);

  /** Top-level threads with the facts Core already holds: presentation, store dates, damage, binding, latest run. */
  listThreads(): HostResults['thread/list']['threads'] {
    return this.catalog.list(this.children.topLevel(this.threads), {
      binding: (threadId) => this.workspaces.readBinding(this.threads, threadId),
      latestRun: (threadId) => this.projections.ledger.readLatestRun(threadId),
      presentation: (threadId) => this.presentations.read(threadId),
    });
  }

  /** Every thread's runs and costed provider calls, folded from its committed log. */
  readonly readLedger = (): HostResults['ledger/read'] => this.projections.ledger.read();

  /** BST-1880: the state store's damage and the threads hydration could not read, for the damaged-store notice. */
  readonly readStateHealth = (): HostResults['state/health/read'] =>
    this.catalog.stateHealth(this.store);

  /** BST-1939: a thread's first and latest stored append and any damage, child threads included. */
  readonly catalogEntry = (threadId: string): ReturnType<HostThreadCatalog['entry']> =>
    this.catalog.entry(threadId);

  readonly updateThread = (params: HostParams<'thread/update'>): Promise<{ accepted: true }> =>
    this.command('thread/update', params, () => this.presentations.update(params));

  readonly read = (threadId: string, fromSeq: number): Promise<HostLogRow[]> =>
    this.catalog.readHistory(nodeHostRowReader(this.store), this.threads, threadId, fromSeq);

  readonly readWorkspace = (
    threadId: string
  ): ReturnType<HostThreadWorkspaceState['readSnapshot']> =>
    this.workspaces.readSnapshot(this.threads, threadId);

  setWorkspace(params: HostParams<'thread/workspace/set'>): Promise<{ accepted: true }> {
    return this.command('thread/workspace/set', params, () =>
      this.workspaces.setSnapshot(params, this.threads)
    );
  }

  readonly readWorkspaceBinding = (
    threadId: string
  ): ReturnType<HostThreadWorkspaceState['readBinding']> =>
    this.workspaces.readBinding(this.threads, threadId);

  updateWorkspaceBinding(
    params: HostParams<'thread/workspace/binding/update'>,
    enteredBy?: HostWorktreeEntry,
    /** Set by Core's own caller already holding an admission slot (`thread-scratch.ts`). */
    held?: true
  ): Promise<{ accepted: true }> {
    const bind = () =>
      this.commands.perform('thread/workspace/binding/update', params, () =>
        this.workspaces.setBinding(params, this.platform, this.pendingAdmissions, enteredBy)
      );
    return held ? bind() : this.admit(params.threadId, bind);
  }
  /** ADR-0034 scratch threads (`thread-scratch.ts`); a folder's move holds one admission slot. */
  readonly scratchWorkspace = (params: HostParams<'thread/workspace/scratch'>) =>
    bindHostScratch(params, this, this.children, this.pendingAdmissions, this.platform);
  readonly scratchProject = (params: HostParams<'thread/workspace/scratch/project'>) =>
    turnHostScratchIntoProject(params, this, this.children, this.runs, this.platform);
  /** One slot of `threadId`'s admission queue; a binding update in it passes `held`. */
  readonly admitted = <T>(threadId: string, move: () => Promise<T>): Promise<T> =>
    this.admit(threadId, move);
  assertAdmissible(threadId: string | undefined): void {
    const { closing, deletions, failedAdmissions, threads } = this;
    assertHostCommandAdmissible(threadId, closing, threads, deletions, failedAdmissions);
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

  /**
   * A command that opens the thread's next run or rewrites its history first
   * joins the memory its finished runs are still settling, outside the shared
   * admission queue so other threads never wait on it. A replay opens nothing.
   * An edit, regenerate or rewind first ends the turns it leaves (`fork`).
   */
  private async settledCommand<T extends Json>(
    method: string,
    params: { commandId: string; threadId: string },
    perform: () => Promise<T>,
    fork?: HostForkPoint
  ): Promise<T> {
    if (!this.commands.known(params.commandId)) {
      await this.ends.settled(params.threadId);
      await endHostAbandonedTurns(this, this.runs, params.threadId, fork);
    }
    return this.command(method, params, perform);
  }

  /** VC-8: resolves once the thread and its children have no work in flight; it starts none. */
  readonly idle = (threadId: string): Promise<void> => this.ends.idle(threadId);

  private admit<T>(
    threadId: string | undefined,
    perform: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const queued = queueHostAdmission(
      this.admission,
      () => {
        this.assertAdmissible(threadId);
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
      payload: accepted.payload,
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
        finish: (run) => this.ends.finish(run, 'stopped'),
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
        scratchFolders: this.platform.scratchFolders,
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
    this.selections.forget(threadId);
    this.mcpInputs.forgetThread(threadId);
    this.records.forgetThread(threadId, this.platform);
    this.compactions.forgetThread(threadId);
    this.rewrites.forgetThread(threadId);
    this.rewinds.forgetThread(threadId);
    this.projections.forget(threadId);
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

  /** A run/start; one the host starts to carry a run's task on records how (`HostRunCarry`). */
  startRun(
    params: HostParams<'run/start'>,
    origin?: HostClientOrigin,
    carry?: Pick<HostNextRun, 'follows' | 'hostPrompt' | 'turnId'>
  ): Promise<{ runId: string }> {
    const record = hostStartCommandRecord(params);
    const { rewinds, runs } = this;
    const position = () => hostCarriedStartPosition(runs, rewinds.position(params), carry);
    const admit = () => this.admitRun('run/start', params, origin, position, record);
    return this.settledCommand('run/start', record, admit, hostRunFork(runs, params));
  }

  /** A new answer to an existing committed user message, on a sibling branch. */
  regenerateRun(
    params: HostParams<'run/regenerate'>,
    origin?: HostClientOrigin
  ): Promise<{ runId: string }> {
    const position = () => hostRegeneratePosition(this.runs.values(), params);
    const fork = hostRunFork(this.runs, params);
    const admit = () => this.admitRun('run/regenerate', params, origin, position);
    return this.settledCommand('run/regenerate', params, admit, fork);
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
    const selected = position();
    const controller = new AbortController();
    this.pendingAdmissions.set(controller, params.threadId);
    let admission: HostRunAdmission | undefined;
    let release: (() => void) | undefined;
    let committed: { readonly runId: string } | undefined;
    // BST-1932: a child thread's run is admitted for its root, then narrowed.
    const root = this.children.rootThread(params.threadId);
    // Admission is for this run: platforms key its selection by the run's ID.
    const runId = randomUUID();
    try {
      this.catalog.assertRunnable(params.threadId);
      assertHostRunAdmissible(this.threads, this.runs.values(), this.conversationIds, params);
      // ADR-0019: a wake admits fresh from the thread's selection, with no user prompt.
      admission = await acquireHostRunAdmission(this.platform, {
        ...hostRunCommandRequest(
          { ...params, runId, threadId: root },
          origin,
          method === 'wake' ? undefined : selected.prompt,
          controller.signal
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
        this.runs.ofThread(params.threadId),
        {
          ...params,
          input: hostRunInput(params.configuration, origin),
          method,
          runId,
        },
        this.ends.deliveryPosition(method, params, selected, runId),
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
      const unavailable = hostMcpUnavailableEvents(admission, run.id);
      // A wake has no client command: its run.started records the delivery it answers.
      // A run command's differing pair becomes the thread's selection (ADR-0019).
      const chosen = method === 'wake' ? [] : this.selections.changes(params);
      const references = hostReferencedFileEvents(admission, run.id);
      const events = [...chosen, started, ...unavailable, ...references];
      committed = { runId: run.id };
      // A live start ends the thread's rewind as recovery's fold does: a later wake follows this run.
      const { foldRows } = this.rewinds;
      await (method === 'wake'
        ? this.append(params.threadId, events, 'normal', foldRows)
        : this.accept(params.threadId, method, record, committed, events, foldRows));
      this.runs.set(run.id, run);
      recordHostConversationId(this.conversationIds, params.commandId);
      recordHostConversationId(this.conversationIds, run.id);
      run.task = beginHostRun(run, admission, {
        commit: (events) => this.append(run.threadId, events, 'full', this.foldRows),
        fail: (detail) => this.ends.finish(run, 'failed', detail),
        loop: (model) => {
          // The prompt passed its UserPromptSubmit hooks: its title is generated beside the answer.
          this.presentations.request(run, this.runs.values());
          return this.loop(run, model);
        },
      });
      // Stop/close joins this task; retain failures rather than leaking rejections.
      run.task.catch(() => undefined);
      return committed;
    } catch (cause) {
      controller.abort(cause);
      return await rejectHostRunAdmission(
        params.threadId,
        cause,
        admission,
        release,
        this.failedAdmissions,
        committed !== undefined
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
      checkouts: { children: this.children, edits: this.records.edits, runs: this.runs },
      closing: () => this.closing,
      commitMessages: (run, messages) => this.commitMessages(run, messages),
      compactions: this.compactions,
      delegate: async (run, action, input) =>
        this.children.delegate(
          { action, admission: await ensureHostRunAdmission(this.platform, run), input, run },
          this.childRunPort(run, action)
        ),
      dispatch: (run, action, input) => this.dispatch(run, action, input),
      enterWorktree: (run, action) =>
        hostWorktreeEntry(this, this.children, this.runs, run, action),
      finish: (run, outcome, detail) => this.ends.finish(run, outcome, detail),
      fold: (row) => this.fold(row),
      foldRows: this.foldRows,
      intake: (run) => this.children.intake(run, this.runs),
      mcpInputs: this.mcpInputs,
      openRun: (run) => this.openRun(run),
      origins: this.store,
      platform: this.platform,
      records: this.records,
      retired: (threadId) => this.closing || this.deletions.has(threadId),
      rewrites: this.rewrites,
      runs: this.runs,
      syncBoundary: (threadId) => this.store.syncBoundary(threadId),
      telemetry: (telemetry) => this.liveTelemetry.publish(telemetry),
    };
  }

  /** BST-1932: HostChildRuns orchestrates a delegation; Core lends its sole writer and loop. */
  private childRunPort(run: Run, action: Action): HostChildRunPort {
    return {
      admitModel: (target, runId) => {
        const threadId = this.children.rootThread(run.threadId);
        const root = { threadId, ...this.workspaces.admissionBinding(threadId) };
        return admitHostChildModel(this.platform, run, root, target, runId);
      },
      commit: async ({ child, items, threadId }) => {
        // BST-2463: the child is readable before any listener hears of its rows.
        await this.appendAcross(items, 'full', () => this.threads.add(threadId));
        this.runs.set(child.id, child);
        recordHostConversationId(this.conversationIds, threadId);
        recordHostConversationId(this.conversationIds, child.id);
      },
      commitEffect: () => this.append(run.threadId, [action]).then(() => undefined),
      loop: (child, model) => this.loop(child, model),
      policy: async (threadId) => await this.platform.readPermissionPolicy(threadId),
      retainRun: this.retainRun,
      runs: this.runs,
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
    // A finished run has nothing to abort; its memory settles undisturbed.
    if (run.terminal) {
      return;
    }
    run.controller.abort(reason);
    await joinHostRunOwner(run, (owned) => this.closeRunOwner(owned));
    await this.ends.finish(run, 'stopped');
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
          this.executionPorts(),
          interactionId,
          (events) => this.append(sibling.threadId, events),
          () => this.continueRun(sibling)
        )
      )
    );
  }

  /** Restore a finished run's edits to their baselines; the outcome joins the thread's log. */
  revertCheckpoint(
    params: HostParams<'checkpoint/revert'>
  ): Promise<HostResults['checkpoint/revert']> {
    const method = 'checkpoint/revert';
    return this.command(method, params, async () => {
      this.runs.requireForThread(params.threadId, params.runId);
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
        const run = this.runs.requireForThread(params.threadId, params.runId);
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

  readonly respond = (params: HostParams<'interaction/respond'>): Promise<{ accepted: true }> =>
    this.answer('interaction/respond', params);
  readonly resume = (params: HostParams<'interaction/resume'>): Promise<{ accepted: true }> =>
    this.answer('interaction/resume', params);
  readonly previewInteraction = hostInteractionPreview(this.runs, () => this.executionPorts());

  private answer(
    method: 'interaction/respond' | 'interaction/resume',
    params: HostParams<'interaction/respond'> | HostParams<'interaction/resume'>
  ): Promise<{ accepted: true }> {
    const run = () => this.runs.requireForThread(params.threadId, params.runId);
    return this.command(method, params, async () => {
      const answered = await commitHostInteractionResponse(
        run(),
        this.executionPorts(),
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
      finish: (outcome, detail) => this.ends.finish(run, outcome, detail),
      loop: (model) => this.loop(run, model),
      openRun: () => this.openRun(run),
      platform: this.platform,
    });
  }

  recordVerdict(params: HostParams<'run/verdict'>): Promise<{ accepted: true }> {
    return this.command('run/verdict', params, async () => {
      const event = userRunVerdict(this.runs.get(params.runId)?.threadId, params);
      await this.accept(params.threadId, 'run/verdict', params, { accepted: true }, [event]);
      return { accepted: true } as const;
    });
  }

  /**
   * ADR-0028 step 3b: a person's message to a thread, committed as its notice. A
   * working run reads it at its next step; an idle thread starts their turn (the wake).
   */
  input(params: HostParams<'run/input'>): Promise<{ accepted: true }> {
    const { threadId } = params;
    return this.command('run/input', params, async () => {
      this.runs.requireForThread(threadId, params.runId);
      assertHostAttachments(params.attachments ?? []);
      await this.accept(threadId, 'run/input', params, { accepted: true }, [], this.foldRows);
      this.ends.wake(threadId);
      return { accepted: true } as const;
    });
  }

  stop(params: HostParams<'run/stop'>): Promise<{ outcome: 'stopped' | 'already-terminal' }> {
    const named = this.runs.get(params.runId);
    const run = named?.threadId === params.threadId ? named : undefined;
    const join = (): Promise<void> =>
      // A Stop refused before it marked its run has nothing to join.
      run?.stopped
        ? stopHostRunTree([run, ...this.children.turnRuns(run, this.runs)], (owned, reason) =>
            this.stopRun(owned, reason)
          )
        : Promise.resolve();
    return stopHostRunOutsideQueue(run, join, () =>
      this.command('run/stop', params, () =>
        acceptHostRunStop(this.runs.requireForThread(params.threadId, params.runId), (result) =>
          this.accept(params.threadId, 'run/stop', params, result, [])
        )
      )
    );
  }

  private openRun(run: Run): Promise<HostRunOwner | undefined> {
    return openHostRunOwner(this.platform, run, {
      append: (threadId, events) => this.append(threadId, events, 'full'),
      readCommittedRows: (ids) => this.projections.readRunnable(this.catalog, ids, run.threadId),
    });
  }

  private closeRunOwner(run: Run): Promise<void> {
    // The title request uses the run's admission: it is joined before the admission closes.
    run.ownerClose ??= this.presentations.join(run).then(() =>
      closeHostRunResources(run, async (failure) => {
        await this.append(run.threadId, [hostRunSettlementFailed(run, failure)], 'full');
      })
    );
    return run.ownerClose;
  }

  private startNextRun(next: HostNextRun, origin: HostClientOrigin | undefined): Promise<boolean> {
    const { params } = next;
    return startHostNextRun(
      this.runs.values(),
      next,
      () => this.startRun(params, origin, next),
      (runId, events) =>
        this.accept(params.threadId, 'run/start', params, { runId }, events, this.foldRows)
    );
  }

  close(): Promise<void> {
    this.closeTask ??= this.closeOwned();
    return this.closeTask;
  }

  private async closeOwned(): Promise<void> {
    await this.idleWorktrees.retire(this.platform);
    this.closing = true;
    this.ends.exits.close();
    // Retirement reads the runs the fold restores; a failed fold still closes what it opened.
    await this.hydrated.catch(() => undefined);
    const outcomes = await retireHostCoreRuns({
      admission: () => this.admission,
      closeOwner: (owned) => this.closeRunOwner(owned),
      closePlatform: () => this.platform.close(),
      failedAdmissions: () => [...this.failedAdmissions.values()],
      finish: (owned) => this.ends.finish(owned, 'interrupted', 'Host is closing'),
      pendingAdmissions: this.pendingAdmissions.keys(),
      runs: () => [...this.runs.values()],
    });
    this.published.close();
    this.liveTelemetry.clear();
    reportRetiredHostOutcomes(outcomes);
  }
}
