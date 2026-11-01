// The token counter worker's owner (BST-2438). Provider requests count their tokens on one worker thread that holds
// the o200k encoder, so neither the encoder's one-time load nor a long conversation's count blocks the host's event
// loop. The worker starts when the host learns a thread uses a tokenizer-measured model, or at the first count. A
// worker that fails or exits fails every count it holds; the next count starts a fresh one. An idle worker never
// holds the process open.
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

export interface TokenCounterRequest {
  readonly id: number;
  readonly text?: string;
}

export type TokenCounterReply =
  | { readonly count: number; readonly id: number }
  | { readonly error: string; readonly id: number }
  | { readonly id: number; readonly unavailable: string }
  | { readonly id: number };

/** The counter cannot count: its encoder failed to load, or its worker failed or exited. */
export class TokenCounterUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TokenCounterUnavailableError';
  }
}

interface Pending {
  readonly reject: (error: Error) => void;
  readonly resolve: (reply: TokenCounterReply) => void;
}

interface Running {
  readonly pending: Map<number, Pending>;
  readonly worker: Worker;
}

// The worker entry sits beside this module with its own extension: TypeScript
// source run by Node, or the desktop bundle's emitted JS.
const WORKER_ENTRY = new URL(
  `./token-counter-worker${extname(fileURLToPath(import.meta.url))}`,
  import.meta.url
);

let running: Running | undefined;
let nextId = 0;

function lose(lost: Running, error: TokenCounterUnavailableError): void {
  if (running === lost) {
    running = undefined;
  }
  for (const waiter of lost.pending.values()) {
    waiter.reject(error);
  }
  lost.pending.clear();
}

function spawn(): Running {
  const spawned: Running = { pending: new Map(), worker: new Worker(WORKER_ENTRY) };
  spawned.worker.on('message', (reply: TokenCounterReply) => {
    const waiter = spawned.pending.get(reply.id);
    if (waiter) {
      spawned.pending.delete(reply.id);
      if (spawned.pending.size === 0) {
        spawned.worker.unref();
      }
      waiter.resolve(reply);
    }
  });
  spawned.worker.on('error', (cause) => {
    lose(
      spawned,
      new TokenCounterUnavailableError(`The token counter failed: ${cause.message}`, { cause })
    );
  });
  spawned.worker.on('exit', (code) => {
    lose(spawned, new TokenCounterUnavailableError(`The token counter exited (code ${code})`));
  });
  // After the listeners: attaching a 'message' listener refs the worker's port again.
  spawned.worker.unref();
  running = spawned;
  return spawned;
}

async function call(text?: string): Promise<TokenCounterReply> {
  const worker = running ?? spawn();
  const id = ++nextId;
  const reply = await new Promise<TokenCounterReply>((resolve, reject) => {
    worker.pending.set(id, { reject, resolve });
    // A count in flight keeps the process alive until it answers.
    worker.worker.ref();
    worker.worker.postMessage(text === undefined ? { id } : { id, text });
  });
  if ('unavailable' in reply) {
    throw new TokenCounterUnavailableError(reply.unavailable);
  }
  if ('error' in reply) {
    throw new Error(reply.error);
  }
  return reply;
}

/** Starts the worker, and with it the encoder's one-time load, without waiting for it. */
export function startTokenCounter(): void {
  if (!running) {
    spawn();
  }
}

/** Resolves once the encoder has loaded; rejects with why it cannot count. */
export async function readyTokenCounter(): Promise<void> {
  await call();
}

/** The o200k token count of `text`, counted on the worker. */
export async function countTokens(text: string): Promise<number> {
  const reply = await call(text);
  if (!('count' in reply)) {
    throw new TokenCounterUnavailableError('The token counter answered without a count');
  }
  return reply.count;
}
