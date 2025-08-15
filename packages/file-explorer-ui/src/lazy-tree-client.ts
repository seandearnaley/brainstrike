import type {
  FilterSpec,
  InboundMessage,
  OutboundMessage,
  TreeNode,
  VisibleRow,
  VisibleSplice,
  WorkerMetrics,
} from './lazy-tree-protocol';

type UnknownResolver = (msg: OutboundMessage<unknown>) => void;
type Rejector = (err: unknown) => void;

export interface LazyTreeClientOptions {
  timeoutMs?: number; // default 120ms
  onVisibleFull?: (rows: VisibleRow[], metrics: WorkerMetrics) => void;
  onVisibleSplices?: (splices: VisibleSplice[], metrics: WorkerMetrics) => void;
  onError?: (err: unknown) => void;
}

export class LazyTreeClient {
  private worker: Worker;
  private inflight = new Map<
    number,
    { resolve: UnknownResolver; reject: Rejector; timer: number }
  >();
  private opts: Required<LazyTreeClientOptions>;

  constructor(opts: LazyTreeClientOptions = {}) {
    // IMPORTANT: adjust path if you colocate worker differently
    this.worker = new Worker(new URL('./workers/lazy-tree-v2.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (e: MessageEvent<OutboundMessage>) => this.onMessage(e.data);
    this.worker.onerror = (e) => this.opts.onError?.(e);

    this.opts = {
      timeoutMs: opts.timeoutMs ?? 120,
      onVisibleFull: opts.onVisibleFull ?? (() => {}),
      onVisibleSplices: opts.onVisibleSplices ?? (() => {}),
      onError: opts.onError ?? (() => {}),
    };
  }

  teardown() {
    for (const { reject, timer } of this.inflight.values()) {
      clearTimeout(timer);
      reject(new Error('Worker terminated'));
    }
    this.inflight.clear();
    this.worker.terminate();
  }

  private send<TReq, TRes = unknown>(
    type: InboundMessage['type'],
    payload?: TReq
  ): Promise<OutboundMessage<TRes>> {
    const reqId = this.nextId++;
    const msg: InboundMessage<TReq> =
      payload !== undefined ? { reqId, type, payload } : ({ reqId, type } as InboundMessage<TReq>);
    const p = new Promise<OutboundMessage<TRes>>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.inflight.delete(reqId);
        reject(new Error(`Worker timeout for ${type}`));
      }, this.opts.timeoutMs);
      const resolveWrapper: UnknownResolver = (msg) => resolve(msg as OutboundMessage<TRes>);
      this.inflight.set(reqId, { resolve: resolveWrapper, reject, timer });
      this.worker.postMessage(msg);
    });
    return p;
  }

  private onMessage<T>(msg: OutboundMessage<T>) {
    const entry = this.inflight.get(msg.reqId);
    if (entry) {
      clearTimeout(entry.timer);
      this.inflight.delete(msg.reqId);
      if (msg.type === 'ERROR') entry.reject(new Error(msg.error || 'Worker error'));
      else entry.resolve(msg);
    } else {
      // streaming/async notifications not used; ignore
    }
    // Side-effects for visible payloads
    if (msg.type === 'VISIBLE_FULL') {
      // @ts-ignore
      const rows = (msg.payload.rows ?? []) as VisibleRow[];
      // @ts-ignore
      const metrics = msg.payload.metrics as WorkerMetrics;
      this.opts.onVisibleFull(rows, metrics);
    }
    if (msg.type === 'VISIBLE_SPLICES') {
      // @ts-ignore
      const splices = (msg.payload.splices ?? []) as VisibleSplice[];
      // @ts-ignore
      const metrics = msg.payload.metrics as WorkerMetrics;
      this.opts.onVisibleSplices(splices, metrics);
    }
  }

  // Public API

  initTree(tree: TreeNode[], expanded: string[], filter?: FilterSpec) {
    return this.send('INIT_TREE', { tree, expanded, filter });
  }
  replaceTree(tree: TreeNode[]) {
    return this.send('REPLACE_TREE', { tree });
  }
  expand(path: string) {
    return this.send('EXPAND', { path });
  }
  collapse(path: string) {
    return this.send('COLLAPSE', { path });
  }
  applyFilter(filter: FilterSpec) {
    return this.send('APPLY_FILTER', { filter });
  }
  fullVisible() {
    return this.send('FULL_VISIBLE');
  }
}
