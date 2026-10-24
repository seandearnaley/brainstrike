import type { ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';

export interface FixtureIdentity {
  readonly executable: string;
  readonly pid: number;
  readonly start: string;
}

export interface FixtureExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

function redact(value: string): string {
  return value
    .replace(/("(?:token|password|apiKey|authorization)"\s*:\s*")[^"]*/gi, '$1[REDACTED]')
    .replace(/((?:token|password|api[_-]?key|authorization)=)[^\s]+/gi, '$1[REDACTED]');
}

function redactEvidence(value: unknown): unknown {
  if (typeof value === 'string') {
    return redact(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactEvidence);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(?:token|password|api[_-]?key|authorization|secret)$/i.test(key)
          ? '[REDACTED]'
          : redactEvidence(item),
      ])
    );
  }
  return value;
}

/** One append-only ledger; never persist the inherited environment or host token. */
export function recordFixtureEvent(event: string, detail: unknown): void {
  const directory = process.env['M3_WINDOWS_EVIDENCE_DIR'];
  if (!directory) {
    return;
  }
  mkdirSync(directory, { recursive: true });
  appendFileSync(
    join(directory, 'fixture-ledger.jsonl'),
    `${JSON.stringify({ detail: redactEvidence(detail), event, utc: new Date().toISOString() })}\n`
  );
}

interface OutputWaiter {
  readonly reject: (cause: unknown) => void;
  readonly release: () => void;
  readonly resolve: () => void;
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
}

/** Event-driven observation. Its caller supplies the existing startup cancellation. */
export class FixtureOutput {
  private output = '';
  private error = '';
  private failure: unknown;
  private readonly waiters = new Set<OutputWaiter>();

  stdout(): string {
    return this.output;
  }

  stderr(): string {
    return this.error;
  }

  accept(stream: 'stdout' | 'stderr', text: string): void {
    if (stream === 'stdout') {
      this.output += text;
    } else {
      this.error += text;
    }
    recordFixtureEvent(stream, { text });
    for (const waiter of this.waiters) {
      if (waiter.stream === stream && this[stream]().includes(waiter.text)) {
        recordFixtureEvent('observed-ready', { stream, text: waiter.text });
        waiter.release();
        waiter.resolve();
      }
    }
  }

  fail(cause: unknown): void {
    this.failure = cause;
    for (const waiter of this.waiters) {
      waiter.release();
      waiter.reject(cause);
    }
  }

  waitFor(stream: 'stdout' | 'stderr', text: string, signal?: AbortSignal): Promise<void> {
    if (this[stream]().includes(text)) {
      recordFixtureEvent('observed-ready', { stream, text });
      return Promise.resolve();
    }
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    return new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        waiter.release();
        reject(signal?.reason);
      };
      const waiter: OutputWaiter = {
        reject,
        release: () => {
          this.waiters.delete(waiter);
          signal?.removeEventListener('abort', abort);
        },
        resolve,
        stream,
        text,
      };
      this.waiters.add(waiter);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
}

export function observeFixtureChild(
  child: ChildProcess,
  identity: (pid: number) => FixtureIdentity,
  options: { readonly stdout?: boolean } = {}
): { readonly output: FixtureOutput; readonly done: Promise<FixtureExit> } {
  const output = new FixtureOutput();
  recordFixtureEvent('spawn-request', { arguments: child.spawnargs, executable: child.spawnfile });
  child.once('spawn', () => {
    if (child.pid) {
      try {
        recordFixtureEvent('spawn', { identity: identity(child.pid) });
      } catch (cause) {
        recordFixtureEvent('spawn-identity-error', { message: String(cause), pid: child.pid });
        output.fail(cause);
      }
    }
  });
  for (const [name, stream] of [
    ['stdout', child.stdout],
    ['stderr', child.stderr],
  ] as const) {
    // Authenticated stdio RPC owns its binary reader and may carry host tokens.
    // Capture its decoded committed rows in the test, leaving raw framing alone.
    if (name !== 'stdout' || options.stdout !== false) {
      stream?.setEncoding('utf8');
      stream?.on('data', (value: string) => output.accept(name, value));
    }
    stream?.once('end', () =>
      recordFixtureEvent('observation-stream-end', { pid: child.pid, stream: name })
    );
    stream?.once('close', () =>
      recordFixtureEvent('observation-stream-close', { pid: child.pid, stream: name })
    );
  }
  child.on('message', (value: unknown) => recordFixtureEvent('ipc-message', value));
  child.once('error', (cause: Error) => {
    recordFixtureEvent('error', { message: cause.message });
    output.fail(cause);
  });
  child.once('close', (code, signal) => {
    recordFixtureEvent('close', { code, pid: child.pid, signal });
  });
  const exited = new Promise<FixtureExit>((resolve, reject) => {
    child.once('exit', (code, signal) => {
      recordFixtureEvent('exit', { code, pid: child.pid, signal });
      resolve({ code, signal });
    });
    child.once('error', reject);
  });
  const disconnected = child.connected
    ? new Promise<void>((resolve) => {
        child.once('disconnect', () => {
          recordFixtureEvent('ipc-disconnect', { pid: child.pid });
          resolve();
        });
      })
    : Promise.resolve();
  const streams = [child.stdin, child.stdout, child.stderr].filter((stream) => stream !== null);
  // ChildProcess destroys the parent's stdin writer on exit. Its owned handle
  // must close; writable finish is not expected if the terminal exited first.
  const inputClosed = child.stdin
    ? new Promise<void>((resolve) => {
        if (child.stdin?.closed) {
          resolve();
        } else {
          child.stdin?.once('close', resolve);
        }
      })
    : Promise.resolve();
  const streamsClosed = Promise.all([
    inputClosed,
    ...[child.stdout, child.stderr]
      .filter((stream) => stream !== null)
      .map((stream) => finished(stream, { cleanup: true })),
  ]);
  // Node 26.8.2 manual IPC disconnect closes its native pipe but omits the
  // maybeClose increment, so ChildProcess.close can remain undelivered:
  // https://github.com/nodejs/node/blob/v26.8.2/lib/internal/child_process.js
  // Remove this independent join when that path consistently emits close.
  // Keep the real close event above; never synthesize it or equate exit with
  // closed transports. finished() joins the owned streams as well as exit.
  const done = Promise.all([exited, streamsClosed, disconnected]).then(([result]) => {
    if (child.connected || child.channel || streams.some((stream) => !stream.closed)) {
      throw new Error('Fixture process exited with an owned transport still open');
    }
    recordFixtureEvent('fixture-transport-joined', {
      pid: child.pid,
      ...result,
      ipcDisconnected: !(child.connected || child.channel),
      streamsClosed: streams.every((stream) => stream.closed),
    });
    output.fail(
      new Error(
        `Fixture child ended before requested readiness: ${JSON.stringify({ ...result, stderr: redact(output.stderr()), stdout: redact(output.stdout()) })}`
      )
    );
    return result;
  });
  // Observe early spawn/stream rejection even while the caller awaits startup.
  void done.catch((cause: unknown) => output.fail(cause));
  return { done, output };
}
