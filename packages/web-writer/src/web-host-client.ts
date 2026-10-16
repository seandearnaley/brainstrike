/**
 * The browser's host client (BST-1940; owner decision, 16 Oct): the part of
 * the host protocol desktop's thread view uses, served over the browser
 * writer, so desktop's `CommittedThreadSession` and `CommittedAssistantLogStore`
 * read web threads unchanged. Its folds are Core's own: the thread catalog,
 * the presentation fold and the ledger projection. It commits a command as
 * Core does: `command.accepted` beside the command's events, in one append,
 * encoded as Core encodes them. Runs come next (`run/start`, `run/stop`).
 */
import type { HostClient } from '@brainstrike/agent-host/browser';
import { HostCommandLedger } from '@brainstrike/agent-host/core-state';
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
import { type HostRowReader, HostThreadCatalog } from '@brainstrike/agent-host/thread-catalog';
import { HostThreadPresentationState } from '@brainstrike/agent-host/thread-presentation-state';
import type { HydrationThread, LogRow, ThreadDamagedError } from '@brainstrike/state-store';
import type { WebStateStore, WebStateStoredRow } from '@brainstrike/web-state-store';

/** A blob can be as large as the text it spools; read it whole. */
const WHOLE_BLOB = Number.MAX_SAFE_INTEGER;
/** Rows a history read takes at a time. */
const PAGE = 500;
const encoder = new TextEncoder();

type ServedMethod =
  | 'ledger/read'
  | 'log/subscribe'
  | 'log/unsubscribe'
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

export class WebHostClient implements Pick<HostClient, 'closed' | 'onEvent' | 'onTelemetry'> {
  readonly #catalog = new HostThreadCatalog();
  /** Why the client closed, once it has: a request after that refuses with it. */
  #closedBy: Error | null = null;
  /** Core's command ledger: a repeated command answers with its first result. */
  readonly #commands = new HostCommandLedger();
  #settleClosed: (failure?: Error) => void = () => {};
  readonly #events = new Set<(row: HostLogRow) => void>();
  /** The highest row of each thread its folds have taken: they take each row once, in order. */
  readonly #folded = new Map<string, number>();
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
  readonly #rows: ReturnType<typeof webRowReader>;
  readonly #store: WebStateStore;
  readonly #subscriptions = new Map<string, Subscription>();
  /** Each thread's reads and deliveries, one after another. */
  readonly #threadQueues = new Map<string, Promise<void>>();
  readonly #threads = new Set<string>();
  readonly #unsubscribeLog: () => void;
  /** Settles as the client closes; rejects with the reason when it could not follow the log. */
  readonly closed = new Promise<void>((resolve, reject) => {
    this.#settleClosed = (failure) => (failure ? reject(failure) : resolve());
  });

  private constructor(store: WebStateStore) {
    this.#store = store;
    this.#rows = webRowReader(store);
    this.#unsubscribeLog = store.subscribeLog(({ threadId }) => {
      // A failure closes the client (`#follow`), which reports it through `closed`.
      this.#follow(threadId).catch(() => {});
    });
  }

  /**
   * Hydrates Core's folds from the writer's committed log, as Core does at open.
   * The log is followed from before the hydration read, so a row committed
   * during it is caught up after.
   */
  static async open(store: WebStateStore): Promise<WebHostClient> {
    const client = new WebHostClient(store);
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
    return client;
  }

  close(): void {
    this.#end(new Error('The browser host client is closed'));
  }

  onEvent(listener: (row: HostLogRow) => void): () => void {
    this.#events.add(listener);
    return () => this.#events.delete(listener);
  }

  /** Runs come with `run/start`; until then a thread has no live telemetry. */
  onTelemetry(_listener: (telemetry: HostRunTelemetry) => void): () => void {
    return () => {};
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
          subscription.subscribers += 1;
          subscription.delivered = Math.max(subscription.delivered, rows.at(-1)?.seq ?? fromSeq);
          this.#subscriptions.set(threadId, subscription);
          return { rows, telemetry: [] };
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
    const stored = [accepted, ...events].map((event) => storedHostEvent(threadId, event));
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
    for (const row of rows) {
      if (subscription && row.seq > subscription.delivered) {
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
    this.#folded.set(row.threadId, row.seq);
    const event = row.event;
    if (event.type === 'command.accepted') {
      this.#commands.commit(event.commandId, {
        method: event.method,
        payload: event.payload,
        result: event.result,
        threadId: row.threadId,
      });
    }
    this.#presentations.fold(row);
    this.#ledger.apply(row);
  }

  #forget(threadId: string): void {
    this.#commands.forgetThread(threadId);
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
