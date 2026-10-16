import type {
  CollectionPort,
  ModelChoicePort,
  PromptCatalogPort,
  SourceCatalogPort,
  ThreadGroupsPort,
  ViewFilterPresetPort,
  WorkspaceRootPort,
} from '@brainstrike/state-store';
import type {
  TabMessage,
  WebStateErrorKind,
  WebStateErrorReply,
  WebStateLease,
  WebStateLogAppend,
  WebStateOp,
  WebStateRequests,
  WebStateStoreConfig,
  WorkerMessage,
} from './protocol';

/** A request the store refused or could not answer, with the writer's error kind. */
export class WebStateStoreError extends Error {
  readonly atSeq: number | undefined;
  /** The failure's own code, when it carries one (an IndexerError's). */
  readonly code: string | undefined;
  readonly kind: WebStateErrorKind | 'closed';
  readonly threadId: string | undefined;

  constructor(reply: WebStateErrorReply | { error: string; errorKind: 'closed' }) {
    super(reply.error);
    this.name = 'WebStateStoreError';
    this.kind = reply.errorKind;
    this.atSeq = 'atSeq' in reply ? reply.atSeq : undefined;
    this.code = 'code' in reply ? reply.code : undefined;
    this.threadId = 'threadId' in reply ? reply.threadId : undefined;
  }
}

export interface WebStateLeaseView {
  /** True while this tab's own worker is the writer. */
  readonly leader: boolean;
  readonly lease: WebStateLease;
}

interface Pending {
  readonly reject: (error: Error) => void;
  readonly resolve: (result: unknown) => void;
}

/**
 * A tab's handle on the origin's state DB. It owns one worker: that worker
 * either writes the store or forwards to the tab whose worker does. `open`
 * settles once a writer is known.
 */
export class WebStateStore
  implements
    CollectionPort,
    ModelChoicePort,
    PromptCatalogPort,
    SourceCatalogPort,
    ThreadGroupsPort,
    ViewFilterPresetPort,
    WorkspaceRootPort
{
  readonly #listeners = new Set<(view: WebStateLeaseView) => void>();
  readonly #logListeners = new Set<(append: WebStateLogAppend) => void>();
  readonly #pending = new Map<number, Pending>();
  readonly #worker: Worker;
  #closed: WebStateStoreError | undefined;
  #nextId = 1;
  /** Settles `open` on the first writer or the first failure. */
  #opening: { readonly reject: (error: Error) => void; readonly resolve: () => void } | undefined;
  #view: WebStateLeaseView | undefined;

  private constructor(worker: Worker) {
    this.#worker = worker;
  }

  /** Starts `worker` (the module worker built from `web-state-worker.ts`) on `config`. */
  static open(worker: Worker, config: WebStateStoreConfig): Promise<WebStateStore> {
    const store = new WebStateStore(worker);
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => store.#receive(event.data);
    worker.onerror = (event: ErrorEvent) => {
      event.preventDefault();
      store.#fail(`The state worker failed: ${event.message}`);
    };
    return new Promise((resolve, reject) => {
      store.#opening = { reject, resolve: () => resolve(store) };
      store.#post({ config, kind: 'open' });
    });
  }

  get lease(): WebStateLeaseView {
    if (!this.#view) {
      throw new Error('The state store has no writer yet');
    }
    return this.#view;
  }

  subscribeLease(listener: (view: WebStateLeaseView) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Tells `listener` of each thread's rows as the writer commits them, from
   * any tab's append, this one's too; a reader of a thread reads them with
   * `read` (BST-1940). Notice comes no later than the next row's, never
   * before its commit.
   */
  subscribeLog(listener: (append: WebStateLogAppend) => void): () => void {
    this.#logListeners.add(listener);
    return () => this.#logListeners.delete(listener);
  }

  append(
    rows: WebStateRequests['append']['params']['rows'],
    options: { readonly boundary?: boolean } = {}
  ): Promise<WebStateRequests['append']['result']> {
    return this.request('append', { boundary: options.boundary === true, rows });
  }

  boundary(threadId: string): Promise<WebStateRequests['boundary']['result']> {
    return this.request('boundary', { threadId });
  }

  /**
   * Factory reset's first step, from any tab: the writer closes the store and
   * releases the pool's handles while keeping the lock, and every tab's store
   * then refuses requests. Delete the pool directory next, then reload.
   */
  retire(): Promise<WebStateRequests['retire']['result']> {
    return this.request('retire', {});
  }

  collections(
    request: WebStateRequests['collections']['params']
  ): Promise<WebStateRequests['collections']['result']> {
    return this.request('collections', request);
  }

  modelChoices(
    request: WebStateRequests['modelChoices']['params']
  ): Promise<WebStateRequests['modelChoices']['result']> {
    return this.request('modelChoices', request);
  }

  sourceCatalog(
    request: WebStateRequests['sourceCatalog']['params']
  ): Promise<WebStateRequests['sourceCatalog']['result']> {
    return this.request('sourceCatalog', request);
  }

  workspaceRoots(
    request: WebStateRequests['workspaceRoots']['params']
  ): Promise<WebStateRequests['workspaceRoots']['result']> {
    return this.request('workspaceRoots', request);
  }

  promptCatalog(
    request: WebStateRequests['promptCatalog']['params']
  ): Promise<WebStateRequests['promptCatalog']['result']> {
    return this.request('promptCatalog', request);
  }

  threadGroups(
    request: WebStateRequests['threadGroups']['params']
  ): Promise<WebStateRequests['threadGroups']['result']> {
    return this.request('threadGroups', request);
  }

  viewFilterPresets(
    request: WebStateRequests['viewFilterPresets']['params']
  ): Promise<WebStateRequests['viewFilterPresets']['result']> {
    return this.request('viewFilterPresets', request);
  }

  /** Stores `content` under its SHA-256 `hash`, before any event names it. */
  putBlob(hash: string, content: string): Promise<WebStateRequests['putBlob']['result']> {
    return this.request('putBlob', { content, hash });
  }

  readBlob(hash: string, maxBytes: number): Promise<WebStateRequests['readBlob']['result']> {
    return this.request('readBlob', { hash, maxBytes });
  }

  storedBlobRefs(threadId: string): Promise<WebStateRequests['storedBlobRefs']['result']> {
    return this.request('storedBlobRefs', { threadId });
  }

  damagedBlobRefs(): Promise<WebStateRequests['damagedBlobRefs']['result']> {
    return this.request('damagedBlobRefs', {});
  }

  /** Deletes a thread with what was derived from it and the blobs nothing else names; needs the derived index. */
  deleteThread(threadId: string): Promise<WebStateRequests['deleteThread']['result']> {
    return this.request('deleteThread', { threadId });
  }

  /** Purges event `seq` from truth, the derived index and the blobs; needs the derived index. */
  purge(threadId: string, seq: number): Promise<WebStateRequests['purge']['result']> {
    return this.request('purge', { seq, threadId });
  }

  check(): Promise<WebStateRequests['check']['result']> {
    return this.request('check', {});
  }

  read(
    threadId: string,
    fromSeq: number,
    limit: number
  ): Promise<WebStateRequests['read']['result']> {
    return this.request('read', { fromSeq, limit, threadId });
  }

  readHydration(): Promise<WebStateRequests['readHydration']['result']> {
    return this.request('readHydration', {});
  }

  settings(): Promise<WebStateRequests['settings']['result']> {
    return this.request('settings', {});
  }

  status(threadId: string): Promise<WebStateRequests['status']['result']> {
    return this.request('status', { threadId });
  }

  threads(): Promise<WebStateRequests['threads']['result']> {
    return this.request('threads', {});
  }

  request<Op extends WebStateOp>(
    op: Op,
    params: WebStateRequests[Op]['params']
  ): Promise<WebStateRequests[Op]['result']> {
    return this.send(op, params) as Promise<WebStateRequests[Op]['result']>;
  }

  /**
   * A request one of the writer's extensions serves (`index.search`); the
   * extension's own client gives it a type.
   */
  extension(op: string, params: unknown): Promise<unknown> {
    return this.send(op, params);
  }

  private send(op: string, params: unknown): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(this.#closed);
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { reject, resolve });
      this.#post({ id, kind: 'request', request: { op, params } });
    });
  }

  /**
   * Terminates this tab's worker. If it was the writer, the lock passes to
   * another tab's worker; this handle's unanswered requests fail as closed.
   */
  close(): void {
    // Always end the worker, even after a retirement already refused requests:
    // a retired writer holds the lock until its worker ends.
    this.#worker.terminate();
    this.#opening?.reject(new Error('The state store was closed before it opened.'));
    this.#opening = undefined;
    if (!this.#closed) {
      this.#settleAll(
        new WebStateStoreError({ error: 'The state store was closed.', errorKind: 'closed' })
      );
    }
  }

  #post(message: TabMessage): void {
    this.#worker.postMessage(message);
  }

  #fail(error: string): void {
    const failure = new WebStateStoreError({ error, errorKind: 'unavailable' });
    this.#opening?.reject(failure);
    this.#opening = undefined;
    this.#worker.terminate();
    this.#settleAll(failure);
  }

  #settleAll(error: WebStateStoreError): void {
    this.#closed = error;
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #receive(message: WorkerMessage): void {
    switch (message.kind) {
      case 'appended':
        for (const append of message.threads) {
          for (const listener of this.#logListeners) {
            listener(append);
          }
        }
        return;
      case 'failed':
        this.#fail(message.error);
        return;
      case 'retired': {
        // The worker stays: if it is the writer, it holds the lock until the tab reloads.
        const retired = new WebStateStoreError({
          error: 'The state store was retired for factory reset; reload the tab to open it again.',
          errorKind: 'unavailable',
        });
        this.#opening?.reject(retired);
        this.#opening = undefined;
        this.#settleAll(retired);
        return;
      }
      case 'lease':
        this.#view = { leader: message.leader, lease: message.lease };
        this.#opening?.resolve();
        this.#opening = undefined;
        for (const listener of this.#listeners) {
          listener(this.#view);
        }
        return;
      case 'reply': {
        const pending = this.#pending.get(message.id);
        if (!pending) {
          return;
        }
        this.#pending.delete(message.id);
        if (message.ok) {
          pending.resolve(message.result);
        } else {
          pending.reject(new WebStateStoreError(message.error));
        }
      }
    }
  }
}
