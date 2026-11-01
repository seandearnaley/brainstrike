// The memory calculator worker's owner (BST-2398). Mastra's memory calculation runs on its own worker thread, so the
// writer thread never imports or runs it and no writer operation waits behind it. The store starts the worker when it
// opens and never awaits it: the worker's 1-2 s module load runs beside startup, not in open or in the first send. A
// worker that fails or exits is replaced at the next request, and the worker stops with the store. It only
// calculates: StateStore reads its inputs and commits its results on the one writer.
import { Worker } from 'node:worker_threads';
import { detachThreadObservations } from './memory-detach.mjs';
import type {
  MemoryCalculation,
  MemoryNativeRequest,
  MemorySharedObservations,
  MemorySnapshot,
} from './memory-types.ts';

/** The memory calculator worker is gone: its module failed to load, it crashed, or the store closed it. */
export class MemoryCalculatorError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MemoryCalculatorError';
  }
}

type Reply = Readonly<Record<string, unknown>> & { readonly id: number; readonly error?: string };

interface Pending {
  readonly reject: (e: Error) => void;
  readonly resolve: (r: Reply) => void;
}

interface Running {
  readonly pending: Map<number, Pending>;
  readonly worker: Worker;
}

export class MemoryCalculator {
  readonly #module: string | undefined;
  #running: Running | undefined;
  #nextId = 0;
  #closed = false;

  /** `module` is the trusted host's calculator module (StateStoreOptions.memoryCalculatorModule), the capability. */
  constructor(module: string | undefined) {
    this.#module = module;
  }

  get available(): boolean {
    return this.#module !== undefined;
  }

  /** The delta a native request makes to `snapshot`, and its value. */
  async calculate(
    snapshot: MemorySnapshot,
    request: MemoryNativeRequest
  ): Promise<MemoryCalculation> {
    return (await this.#call({ op: 'calculate', request, snapshot }))[
      'calculation'
    ] as MemoryCalculation;
  }

  /** Each resource's shared observation records that lose `threadId`'s sections, with their detached payloads. */
  async detach(
    shared: readonly MemorySharedObservations[],
    threadId: string
  ): Promise<MemorySharedObservations[]> {
    if (shared.every((entry) => entry.records.length === 0)) {
      return [...shared];
    }
    if (this.#module === undefined) {
      // Without a token counter, a record whose sections must be recounted fails; one that has none is kept.
      return shared.map((entry) => ({
        ...entry,
        records: detachThreadObservations(entry.records, threadId, undefined),
      }));
    }
    return (await this.#call({ op: 'detach', shared, threadId }))[
      'detached'
    ] as MemorySharedObservations[];
  }

  /** Starts the worker without waiting for it; a request posted meanwhile waits in its queue. */
  start(): void {
    if (this.#module !== undefined && !this.#closed && this.#running === undefined) {
      this.#spawn(this.#module);
    }
  }

  /** Stops the worker; a request it holds fails. */
  async close(): Promise<void> {
    this.#closed = true;
    const running = this.#running;
    if (!running) {
      return;
    }
    this.#lose(running, new MemoryCalculatorError('The memory calculator was closed'));
    await running.worker.terminate();
  }

  #call(message: Readonly<Record<string, unknown>>): Promise<Reply> {
    if (this.#module === undefined) {
      return Promise.reject(new Error('Native memory calculator capability is unavailable'));
    }
    if (this.#closed) {
      return Promise.reject(new MemoryCalculatorError('The memory calculator was closed'));
    }
    const running = this.#running ?? this.#spawn(this.#module);
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      running.pending.set(id, { reject, resolve });
      running.worker.postMessage({ ...message, id });
    });
  }

  #spawn(module: string): Running {
    const running: Running = {
      pending: new Map(),
      worker: new Worker(new URL('./memory-calculator-worker.mjs', import.meta.url), {
        workerData: module,
      }),
    };
    running.worker.on('message', (m: Reply) => {
      const waiter = running.pending.get(m.id);
      if (!waiter) {
        return;
      }
      running.pending.delete(m.id);
      if (m.error === undefined) {
        waiter.resolve(m);
      } else {
        waiter.reject(new Error(m.error));
      }
    });
    // A worker that fails or exits fails every request it holds; the next request starts a fresh one.
    running.worker.on('error', (cause) => {
      this.#lose(
        running,
        new MemoryCalculatorError(`The memory calculator failed: ${cause.message}`, { cause })
      );
    });
    running.worker.on('exit', (code) => {
      this.#lose(running, new MemoryCalculatorError(`The memory calculator exited (code ${code})`));
    });
    this.#running = running;
    return running;
  }

  #lose(running: Running, error: MemoryCalculatorError): void {
    if (this.#running === running) {
      this.#running = undefined;
    }
    for (const waiter of running.pending.values()) {
      waiter.reject(error);
    }
    running.pending.clear();
  }
}
