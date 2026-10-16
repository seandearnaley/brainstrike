/**
 * The browser's host client (BST-1940; owner decision, 16 Oct): the part of
 * the host protocol desktop's thread view uses, served over the browser
 * writer, so desktop's `CommittedThreadSession` and `CommittedAssistantLogStore`
 * read web threads unchanged. Its folds are Core's own: the thread catalog,
 * the presentation fold and the ledger projection. It commits a command as
 * Core does: `command.accepted` beside the command's events, in one append,
 * encoded as Core encodes them. Its runs are Core's run fold: a run starts
 * as Core admits one (one root run per thread, across tabs), and the tab that
 * started it records it from the proxy's turn (`web-run-recorder.ts`).
 */
import type { HostClient } from '@brainstrike/agent-host/browser';
import {
  foldHostAcceptedCommand,
  foldHostRunEffect,
  HostCommandLedger,
  HostRunMap,
  type HostThreadGrants,
} from '@brainstrike/agent-host/core-state';
import { hostEventSpool, takeRunSnapshotRef } from '@brainstrike/agent-host/host-event-decoding';
import { storedHostEvent } from '@brainstrike/agent-host/host-event-encoding';
import { decodeHostRow } from '@brainstrike/agent-host/host-state-producer';
import { HostLedgerProjection } from '@brainstrike/agent-host/ledger-projection';
import {
  type HostEvent,
  type HostLogRow,
  type HostMethod,
  type HostParams,
  type HostResults,
  type HostRunTelemetry,
  parseHostParams,
} from '@brainstrike/agent-host/protocol';
import {
  admittedHostRun,
  assertHostRunAdmissible,
  foldHostConversationMessages,
  foldHostRunAdmission,
  foldHostStartedRun,
  type HostRunAdmissionCommand,
  hostRunContext,
  hostStartCommandRecord,
  hostStartPosition,
} from '@brainstrike/agent-host/run-branch';
import { HostTelemetryReplay } from '@brainstrike/agent-host/telemetry-replay';
import { type HostRowReader, HostThreadCatalog } from '@brainstrike/agent-host/thread-catalog';
import { HostThreadPresentationState } from '@brainstrike/agent-host/thread-presentation-state';
import { createLogger } from '@brainstrike/logging';
import type { HydrationThread, LogRow, ThreadDamagedError } from '@brainstrike/state-store';
import {
  type WebStateStore,
  type WebStateStoredRow,
  webStateNames,
} from '@brainstrike/web-state-store';
import { recordWebRun, WebRunInterrupted } from './web-run-recorder';
import type { WebRunContextMessage, WebRunTurn } from './web-run-turn';

const logger = createLogger('WebHostClient');

/** A blob can be as large as the text it spools; read it whole. */
const WHOLE_BLOB = Number.MAX_SAFE_INTEGER;
/** Rows a history read takes at a time. */
const PAGE = 500;
const encoder = new TextEncoder();

type ServedMethod =
  | 'ledger/read'
  | 'log/subscribe'
  | 'log/unsubscribe'
  | 'run/start'
  | 'run/stop'
  | 'thread/delete'
  | 'thread/list'
  | 'thread/read'
  | 'thread/start'
  | 'thread/update';

/** A stored row as the run log's reader gives desktop one. */
function logRow(threadId: string, stored: WebStateStoredRow): LogRow {
  return {
    event: JSON.parse(stored.payload) as LogRow['event'],
    raw: stored.payload,
    ...(stored.rawCount === null ? {} : { rawCount: stored.rawCount }),
    seq: stored.seq,
    threadId,
    ts: stored.ts,
  };
}

/** The browser's row reader: a row's spooled body and run snapshot come from the writer's blobs. */
function webRowReader(store: WebStateStore): HostRowReader & {
  /** A thread's committed rows after `fromSeq`, known to this tab or not. */
  readonly readAfter: (threadId: string, fromSeq: number) => Promise<HostLogRow[]>;
} {
  const readRow = async (row: LogRow): Promise<HostLogRow> => {
    const { seq: _storedSeq, ...body } = row.event as Record<string, unknown>;
    const hashes = [hostEventSpool(body)?.blob, takeRunSnapshotRef(body).ref].filter(
      (hash): hash is string => hash !== undefined
    );
    const blobs = new Map<string, Uint8Array>();
    for (const hash of hashes) {
      const { content } = await store.readBlob(hash, WHOLE_BLOB);
      if (content === null) {
        throw new Error(`The writer could not read blob ${hash}`);
      }
      blobs.set(hash, encoder.encode(content));
    }
    const decoded = decodeHostRow(row.raw, 'prod', (hash) => {
      const bytes = blobs.get(hash);
      if (!bytes) {
        throw new Error(`Host row names blob ${hash}, which was not read`);
      }
      return bytes;
    });
    if (decoded.type === 'purged' || decoded.type === 'unreadable') {
      throw new Error(
        decoded.type === 'purged'
          ? `Row ${row.seq} of thread ${row.threadId} was purged`
          : `Row ${row.seq} of thread ${row.threadId} is unreadable: ${decoded.reason}`
      );
    }
    const { seq: _seq, ...event } = decoded;
    return {
      event,
      seq: row.seq,
      threadId: row.threadId,
      ...(row.ts === undefined ? {} : { ts: row.ts }),
    };
  };
  const readAfter = async (threadId: string, fromSeq: number): Promise<HostLogRow[]> => {
    const rows: HostLogRow[] = [];
    for (let next = fromSeq + 1; ; ) {
      const page = await store.read(threadId, next, PAGE);
      if (page.damage) {
        throw new Error(page.damage.error);
      }
      for (const stored of page.rows) {
        rows.push(await readRow(logRow(threadId, stored)));
      }
      const last = page.rows.at(-1);
      if (!last || page.rows.length < PAGE) {
        return rows;
      }
      next = last.seq + 1;
    }
  };
  return {
    readAfter,
    readHistory: async (threads, threadId, fromSeq) => {
      if (!threads.has(threadId)) {
        throw new Error('Unknown thread');
      }
      return readAfter(threadId, fromSeq);
    },
    readRow,
  };
}

interface Subscription {
  /** The highest row this thread's subscribers have been given. */
  delivered: number;
  subscribers: number;
}

/** A run this tab records: aborted by a committed Stop, a deletion or the client closing. */
interface Recording {
  readonly controller: AbortController;
  readonly done: Promise<void>;
  readonly threadId: string;
}

export interface WebHostClientOptions {
  /** The turn a run sends; without one the client starts no run. */
  readonly turn?: WebRunTurn;
}

/** What a run that no tab records any more is, as Core recovers one after an unclean exit. */
const ABANDONED_DETAIL = 'The tab recording this run closed before it finished';

export class WebHostClient implements Pick<HostClient, 'closed' | 'onEvent' | 'onTelemetry'> {
  /** Each committed run admission, until its run.started folds. */
  readonly #admittedRuns = new Map<string, HostRunAdmissionCommand>();
  readonly #catalog = new HostThreadCatalog();
  /** Why the client closed, once it has: a request after that refuses with it. */
  #closedBy: Error | null = null;
  /** Core's command ledger: a repeated command answers with its first result. */
  readonly #commands = new HostCommandLedger();
  readonly #conversationIds = new Set<string>();
  #settleClosed: (failure?: Error) => void = () => {};
  readonly #events = new Set<(row: HostLogRow) => void>();
  /** The highest row of each thread its folds have taken: they take each row once, in order. */
  readonly #folded = new Map<string, number>();
  /** A thread's permission grants; a web turn has no tools to grant. */
  readonly #grants = new Map<string, HostThreadGrants>();
  #markHydrated: () => void = () => {};
  /** Settles once Core's folds have hydrated at open; the log's announcements fold after it. */
  readonly #hydrated = new Promise<void>((resolve) => {
    this.#markHydrated = resolve;
  });
  readonly #ledger = new HostLedgerProjection();
  readonly #presentations = new HostThreadPresentationState({
    admit: () => Promise.reject(new Error('The browser host generates no thread titles yet')),
    append: () => Promise.reject(new Error('The browser host generates no thread titles yet')),
    update: (params, event) =>
      this.#accept(params.threadId, 'thread/update', params, { accepted: true }, [event]),
  });
  readonly #recordings = new Map<string, Recording>();
  readonly #rows: ReturnType<typeof webRowReader>;
  /** Core's run fold: every committed run of every thread. */
  readonly #runs = new HostRunMap();
  readonly #store: WebStateStore;
  readonly #subscriptions = new Map<string, Subscription>();
  /** Core's replay of this tab's live run telemetry, for a view that subscribes late. */
  readonly #telemetry = new HostTelemetryReplay();
  /** Waiters for a run's run.finished to fold, by run. */
  readonly #terminal = new Map<string, Set<() => void>>();
  /** Each thread's reads and deliveries, one after another. */
  readonly #threadQueues = new Map<string, Promise<void>>();
  readonly #threads = new Set<string>();
  readonly #turn: WebRunTurn | undefined;
  readonly #unsubscribeLog: () => void;
  /** Settles as the client closes; rejects with the reason when it could not follow the log. */
  readonly closed = new Promise<void>((resolve, reject) => {
    this.#settleClosed = (failure) => (failure ? reject(failure) : resolve());
  });

  private constructor(store: WebStateStore, options: WebHostClientOptions) {
    this.#store = store;
    this.#turn = options.turn;
    this.#rows = webRowReader(store);
    this.#unsubscribeLog = store.subscribeLog(({ threadId }) => {
      // A failure closes the client (`#follow`), which reports it through `closed`.
      this.#follow(threadId).catch(() => {});
    });
  }

  /**
   * Hydrates Core's folds from the writer's committed log, as Core does at open.
   * The log is followed from before the hydration read, so a row committed
   * during it is caught up after. A run that no tab records any more is then
   * finished, as Core recovers its runs at open.
   */
  static async open(
    store: WebStateStore,
    options: WebHostClientOptions = {}
  ): Promise<WebHostClient> {
    const client = new WebHostClient(store, options);
    try {
      await client.#catalog.hydrate(
        {
          // The browser writer's own collection keeps the blobs of a damaged thread (`damagedBlobRefs`).
          holdBlobGc: () => async () => {},
          readHydration: async () => (await store.readHydration()).threads.map(hydrationThread),
        },
        client.#rows,
        client.#threads,
        (row) => client.#fold(row)
      );
    } catch (error) {
      client.close();
      throw error;
    } finally {
      client.#markHydrated();
    }
    const open = new Set(
      [...client.#runs.values()].filter((run) => !run.terminal).map((run) => run.threadId)
    );
    try {
      for (const threadId of open) {
        await client.#withThread(threadId, () => client.#recoverAbandoned(threadId));
      }
    } catch (error) {
      client.close();
      throw error;
    }
    return client;
  }

  /** Ends the client; a run it was recording ends interrupted, keeping its partial reply. */
  close(): void {
    for (const { controller } of this.#recordings.values()) {
      controller.abort(new WebRunInterrupted(ABANDONED_DETAIL));
    }
    this.#end(new Error('The browser host client is closed'));
  }

  onEvent(listener: (row: HostLogRow) => void): () => void {
    this.#events.add(listener);
    return () => this.#events.delete(listener);
  }

  /** The live text and reasoning of the runs this tab records; another tab's arrive as committed steps. */
  onTelemetry(listener: (telemetry: HostRunTelemetry) => void): () => void {
    return this.#telemetry.subscribe(listener);
  }

  async request<M extends HostMethod>(method: M, input: HostParams<M>): Promise<HostResults[M]> {
    if (this.#closedBy) {
      throw this.#closedBy;
    }
    const params = parseHostParams(method, input) as HostParams<ServedMethod>;
    return (await this.#serve(method as ServedMethod, params as never)) as HostResults[M];
  }

  async #serve(method: ServedMethod, params: HostParams<ServedMethod>): Promise<unknown> {
    switch (method) {
      case 'thread/list':
        return {
          threads: this.#catalog.list([...this.#threads], {
            binding: () => ({ binding: null }),
            latestRun: (threadId) => this.#ledger.readLatestRun(threadId),
            presentation: (threadId) => this.#presentations.read(threadId),
          }),
        };
      case 'thread/start': {
        const started = params as HostParams<'thread/start'>;
        return this.#commands.perform('thread/start', started, async () => {
          const result = { threadId: crypto.randomUUID() };
          await this.#accept(result.threadId, 'thread/start', started, result, [
            { commandId: started.commandId, type: 'thread.started' },
          ]);
          this.#threads.add(result.threadId);
          return result;
        });
      }
      case 'thread/read': {
        const { fromSeq, threadId } = params as HostParams<'thread/read'>;
        return {
          rows: await this.#catalog.readHistory(this.#rows, this.#threads, threadId, fromSeq),
        };
      }
      case 'thread/update': {
        const update = params as HostParams<'thread/update'>;
        if (!this.#threads.has(update.threadId)) {
          throw new Error('Unknown thread');
        }
        return this.#commands.perform('thread/update', update, () =>
          this.#presentations.update(update)
        );
      }
      case 'thread/delete': {
        const { threadId } = params as HostParams<'thread/delete'>;
        if (!this.#threads.has(threadId)) {
          throw new Error('Unknown thread');
        }
        // As Core joins a thread's runs before erasing it.
        const recorded = [...this.#recordings.values()].filter((r) => r.threadId === threadId);
        for (const { controller } of recorded) {
          controller.abort(new Error('Thread deleted'));
        }
        await Promise.allSettled(recorded.map(({ done }) => done));
        await this.#store.deleteThread(threadId);
        this.#forget(threadId);
        return { deleted: true, threadIds: [threadId] };
      }
      case 'log/subscribe': {
        const { fromSeq, threadId } = params as HostParams<'log/subscribe'>;
        return this.#serially(threadId, async () => {
          const rows = await this.#catalog.readHistory(
            this.#rows,
            this.#threads,
            threadId,
            fromSeq
          );
          const subscription = this.#subscriptions.get(threadId) ?? {
            delivered: 0,
            subscribers: 0,
          };
          const last = rows.at(-1)?.seq;
          if (subscription.subscribers > 0) {
            // The thread's subscribers so far are given what this replay read past their rows;
            // a view already holding a row takes it once.
            this.#deliver(subscription, rows);
          } else {
            subscription.delivered = Math.max(subscription.delivered, last ?? fromSeq);
          }
          subscription.subscribers += 1;
          this.#subscriptions.set(threadId, subscription);
          return { rows, telemetry: this.#telemetry.replay(threadId) };
        });
      }
      case 'log/unsubscribe': {
        const { threadId } = params as HostParams<'log/unsubscribe'>;
        const subscription = this.#subscriptions.get(threadId);
        if (subscription && --subscription.subscribers <= 0) {
          this.#subscriptions.delete(threadId);
        }
        return { unsubscribed: true };
      }
      case 'run/start': {
        const start = params as HostParams<'run/start'>;
        const record = hostStartCommandRecord(start);
        return this.#commands.perform('run/start', record, () => this.#admitRun(start, record));
      }
      case 'run/stop': {
        const stop = params as HostParams<'run/stop'>;
        const joined = async (result: HostResults['run/stop']) => {
          await this.#finished(stop.runId);
          return result;
        };
        return this.#commands.perform(
          'run/stop',
          stop,
          () => this.#stopRun(stop).then(joined),
          joined
        );
      }
      case 'ledger/read':
        return this.#ledger.read();
      default:
        throw new Error(`The browser host does not serve ${method as string}`);
    }
  }

  /** Core's `accept`: the command's record and its events, committed in one append. */
  async #accept(
    threadId: string,
    method: string,
    params: { readonly commandId: string },
    result: HostResults[keyof HostResults],
    events: readonly HostEvent[]
  ): Promise<void> {
    const accepted: HostEvent = {
      commandId: params.commandId,
      method,
      payload: JSON.parse(JSON.stringify(params)),
      result: JSON.parse(JSON.stringify(result)),
      type: 'command.accepted',
    };
    await this.#append(threadId, [accepted, ...events]);
  }

  /** Core's `append`: events encoded as Core stores them, their blobs first, in one append. */
  async #append(threadId: string, events: readonly HostEvent[]): Promise<void> {
    const stored = events.map((event) => storedHostEvent(threadId, event));
    for (const item of stored) {
      for (const blob of item.blobs ?? []) {
        await this.#store.putBlob(blob.hash, blob.content);
      }
    }
    await this.#store.append(
      stored.map((item) => {
        const runId = (item.event as { runId?: unknown }).runId;
        return [
          item.threadId,
          item.event.type,
          typeof runId === 'string' ? runId : null,
          JSON.stringify(item.event),
          null,
          item.hydrate === false ? 0 : 1,
        ] as const;
      })
    );
    // As Core folds a command's rows as it commits them, this tab's next read sees them;
    // the rows before them another tab committed fold first.
    await this.#follow(threadId);
  }

  /**
   * Brings a thread's folds and subscribers up to the writer's log, after this
   * tab's commit or any tab's announcement. A client whose folds cannot follow
   * the log closes, so its views report the loss rather than go stale.
   */
  #follow(threadId: string): Promise<void> {
    return this.#serially(threadId, () => this.#catchUp(threadId)).catch((cause: unknown) => {
      this.#end(cause instanceof Error ? cause : new Error(String(cause)), true);
      throw cause;
    });
  }

  /**
   * The thread's rows past its folds' cursor fold in order, and its subscribers
   * are given those past theirs. Announcements and this tab's own commits can
   * arrive in any order: a row another tab committed first still folds first.
   */
  async #catchUp(threadId: string): Promise<void> {
    await this.#hydrated;
    if (this.#closedBy) {
      return;
    }
    const folded = this.#folded.get(threadId) ?? 0;
    const delivered = this.#subscriptions.get(threadId)?.delivered ?? folded;
    const rows = await this.#rows.readAfter(threadId, Math.min(folded, delivered));
    if (rows.length === 0) {
      return;
    }
    this.#threads.add(threadId);
    const unfolded = rows.filter((row) => row.seq > folded);
    this.#catalog.noteCommitted(unfolded);
    for (const row of unfolded) {
      this.#fold(row);
    }
    const subscription = this.#subscriptions.get(threadId);
    if (subscription) {
      this.#deliver(subscription, rows);
    }
  }

  /** Gives a thread's subscribers its rows past those they were given, in order. */
  #deliver(subscription: Subscription, rows: readonly HostLogRow[]): void {
    for (const row of rows) {
      if (row.seq > subscription.delivered) {
        subscription.delivered = row.seq;
        for (const listener of this.#events) {
          listener(row);
        }
      }
    }
  }

  #end(reason: Error, failed = false): void {
    if (this.#closedBy) {
      return;
    }
    this.#closedBy = reason;
    this.#unsubscribeLog();
    this.#settleClosed(failed ? reason : undefined);
  }

  #fold(row: HostLogRow): void {
    const event = row.event;
    if (event.type === 'thread.started' && 'origin' in event) {
      // A web turn has no tools, so it never delegates; Core's child topology is not composed here.
      throw new Error(
        `Thread ${row.threadId} is a delegated child thread, which the browser host does not serve`
      );
    }
    this.#folded.set(row.threadId, row.seq);
    // Core's fold (`HostCore.fold`), for the events a web run commits.
    switch (event.type) {
      case 'command.accepted':
        foldHostAcceptedCommand(this.#commands, this.#runs, event, row.threadId);
        foldHostRunAdmission(this.#admittedRuns, this.#conversationIds, event);
        if (event.method === 'run/stop') {
          // A Stop committed in any tab stops the run where it is recorded.
          const { runId } = event.payload as { readonly runId: string };
          this.#recordings.get(runId)?.controller.abort(new Error('Run stopped by user'));
        }
        break;
      case 'run.started':
        foldHostStartedRun(
          this.#admittedRuns,
          this.#conversationIds,
          this.#runs,
          row.threadId,
          event,
          this.#grantsOf(row.threadId),
          () => false
        );
        break;
      case 'model.step':
      case 'model.messages':
        foldHostConversationMessages(this.#runs, event);
        break;
      default:
        foldHostRunEffect(this.#runs, event, row.ts);
        break;
    }
    this.#presentations.fold(row);
    this.#ledger.apply(row);
    this.#telemetry.committed(row);
    if (event.type === 'run.finished') {
      for (const settle of this.#terminal.get(event.runId) ?? []) {
        settle();
      }
      this.#terminal.delete(event.runId);
    }
  }

  #grantsOf(threadId: string): HostThreadGrants {
    let grants = this.#grants.get(threadId);
    if (!grants) {
      grants = { categories: new Set(), tools: new Set() };
      this.#grants.set(threadId, grants);
    }
    return grants;
  }

  /** A Web Lock this store's tabs share: a thread's admission, or a run's recording. */
  #lock(kind: 'run' | 'thread', id: string): string {
    return `${webStateNames(this.#store.name).lock}/${kind}/${id}`;
  }

  /** Runs `perform` while this tab alone admits on the thread, after folding every row of it. */
  #withThread<T>(threadId: string, perform: () => Promise<T>): Promise<T> {
    return navigator.locks.request(this.#lock('thread', threadId), async () => {
      await this.#follow(threadId);
      return perform();
    });
  }

  /**
   * Finishes the thread's runs that no tab records: their recording lock is
   * free, so the tab that started one closed mid-run. As Core recovers a run
   * after an unclean exit (`recoverHostRun`): a stopped run finishes stopped,
   * any other interrupted; uncommitted output is lost. Held under the thread's
   * lock, which a run's tab holds until its recording lock is taken.
   */
  async #recoverAbandoned(threadId: string): Promise<void> {
    if (this.#runs.ofThread(threadId).every((run) => run.terminal)) {
      return;
    }
    const { held = [] } = await navigator.locks.query();
    const recorded = new Set(held.map((lock) => lock.name));
    // A recording commits its run.finished before its lock frees: read past the query first.
    await this.#follow(threadId);
    for (const run of this.#runs.ofThread(threadId)) {
      if (!(run.terminal || recorded.has(this.#lock('run', run.id)))) {
        await this.#append(threadId, [
          run.stopped
            ? { outcome: 'stopped', runId: run.id, type: 'run.finished' }
            : {
                detail: ABANDONED_DETAIL,
                outcome: 'interrupted',
                runId: run.id,
                type: 'run.finished',
              },
        ]);
      }
    }
  }

  /** Settles once the run's run.finished has folded here. */
  #finished(runId: string): Promise<void> {
    if (this.#runs.get(runId)?.terminal) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const waiting = this.#terminal.get(runId) ?? new Set();
      waiting.add(resolve);
      this.#terminal.set(runId, waiting);
    });
  }

  /** Core's admission (`HostCore.admitRun`) for a web run: one root run at a time per thread, across tabs. */
  #admitRun(
    params: HostParams<'run/start'>,
    record: ReturnType<typeof hostStartCommandRecord>
  ): Promise<HostResults['run/start']> {
    const turn = this.#turn;
    if (!turn) {
      return Promise.reject(new Error('The browser host has no turn to send a run'));
    }
    if (params.planMode) {
      return Promise.reject(
        new Error('The browser host runs no plan mode: a web turn has no tools')
      );
    }
    return this.#withThread(params.threadId, async () => {
      await this.#recoverAbandoned(params.threadId);
      this.#catalog.assertRunnable(params.threadId);
      assertHostRunAdmissible(this.#threads, this.#runs.values(), this.#conversationIds, params);
      const runId = crypto.randomUUID();
      const { started } = admittedHostRun(
        this.#runs.ofThread(params.threadId),
        {
          commandId: params.commandId,
          method: 'run/start',
          modelId: params.modelId,
          runId,
          threadId: params.threadId,
        },
        hostStartPosition(this.#runs.values(), params),
        this.#grantsOf(params.threadId),
        // A hosted turn is one step with no tools.
        { configuration: params.configuration ?? {}, maxSteps: 1, toolIdentities: {} },
        new AbortController()
      );
      await this.#accept(params.threadId, 'run/start', record, { runId }, [started]);
      const run = this.#runs.requireForThread(params.threadId, runId);
      await this.#record(turn, params, runId, hostRunContext(this.#runs, run));
      return { runId };
    });
  }

  /**
   * Records the run under its own lock, taken before the thread's admission
   * releases, so another tab never takes a live run for an abandoned one.
   */
  async #record(
    turn: WebRunTurn,
    params: HostParams<'run/start'>,
    runId: string,
    messages: readonly WebRunContextMessage[]
  ): Promise<void> {
    const { threadId } = params;
    const controller = new AbortController();
    let markHeld: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      markHeld = resolve;
    });
    const done = navigator.locks
      .request(this.#lock('run', runId), async () => {
        markHeld();
        await recordWebRun(
          turn,
          { configuration: params.configuration, messages, modelId: params.modelId },
          {
            commit: (events) => this.#append(threadId, events),
            runId,
            signal: controller.signal,
            telemetry: (chunk) => this.#telemetry.publish({ chunk, runId, threadId }),
          }
        );
      })
      .finally(() => this.#recordings.delete(runId));
    // A recording that cannot commit its finish leaves the run to the next recovery.
    done.catch((cause: unknown) => {
      markHeld();
      logger.warn('A web run could not be recorded to its finish', {
        errorName: cause instanceof Error ? cause.name : typeof cause,
        runId,
        threadId,
      });
    });
    this.#recordings.set(runId, { controller, done, threadId });
    await held;
  }

  /** Core's Stop (`acceptHostRunStop`): the committed Stop stops the run in the tab that records it. */
  #stopRun(stop: HostParams<'run/stop'>): Promise<HostResults['run/stop']> {
    return this.#withThread(stop.threadId, async () => {
      const run = this.#runs.requireForThread(stop.threadId, stop.runId);
      const result = { outcome: run.terminal ? 'already-terminal' : 'stopped' } as const;
      await this.#accept(stop.threadId, 'run/stop', stop, result, []);
      // A run no tab records any more finishes stopped here.
      await this.#recoverAbandoned(stop.threadId);
      return result;
    });
  }

  #forget(threadId: string): void {
    for (const commandId of this.#commands.forgetThread(threadId)) {
      this.#conversationIds.delete(commandId);
    }
    for (const run of this.#runs.ofThread(threadId)) {
      this.#runs.delete(run.id);
      this.#conversationIds.delete(run.id);
    }
    this.#grants.delete(threadId);
    this.#threads.delete(threadId);
    this.#folded.delete(threadId);
    this.#subscriptions.delete(threadId);
    this.#presentations.forget(threadId);
    this.#ledger.forget(threadId);
    void this.#catalog.forget(threadId);
  }

  #serially<T>(threadId: string, run: () => Promise<T>): Promise<T> {
    const next = (this.#threadQueues.get(threadId) ?? Promise.resolve()).then(run, run);
    this.#threadQueues.set(
      threadId,
      next.then(
        () => undefined,
        () => undefined
      )
    );
    return next;
  }
}

/** The writer's hydration read as desktop's store gives Core one. */
function hydrationThread(thread: {
  readonly createdAt: number;
  readonly damage: { readonly atSeq?: number; readonly error: string } | null;
  readonly rows: readonly WebStateStoredRow[];
  readonly threadId: string;
  readonly updatedAt: number;
}): HydrationThread {
  return {
    createdAt: thread.createdAt,
    ...(thread.damage
      ? {
          damage: Object.assign(new Error(thread.damage.error), {
            atSeq: thread.damage.atSeq ?? 0,
            name: 'ThreadDamagedError',
            threadId: thread.threadId,
          }) as ThreadDamagedError,
        }
      : {}),
    rows: thread.rows.map((row) => logRow(thread.threadId, row)),
    threadId: thread.threadId,
    updatedAt: thread.updatedAt,
  };
}
