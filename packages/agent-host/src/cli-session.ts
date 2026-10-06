import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { HostCliOutput } from './cli.js';
import type { HostClient } from './client.js';
import type { HostLogRow } from './protocol.js';
import { CommittedThreadView, foldHostRuns, type PendingHostApproval } from './thread-view.js';

export class HostCliExitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number
  ) {
    super(message);
    this.name = 'HostCliExitError';
  }
}

export interface HostCliSessionOptions {
  readonly client: HostClient;
  readonly interactive: boolean;
  readonly json: boolean;
  readonly output: HostCliOutput;
  readonly runId?: string;
  readonly startRun?: () => Promise<{ runId: string }>;
  readonly threadId: string;
}

function displayRow(row: HostLogRow, output: HostCliOutput, json: boolean): void {
  if (json) {
    output.write(`${JSON.stringify(row)}\n`);
    return;
  }
  const event = row.event;
  if (event.type === 'stream.chunk') {
    const chunk = event.chunk;
    if (
      chunk &&
      typeof chunk === 'object' &&
      !Array.isArray(chunk) &&
      chunk['type'] === 'text-delta' &&
      typeof chunk['text'] === 'string'
    ) {
      output.write(chunk['text']);
    }
  } else if (event.type === 'effect.finished') {
    output.write(`\n${JSON.stringify(event.output)}\n`);
  } else if (event.type === 'run.finished') {
    output.write('\n');
  }
}

/** The terminal observes committed rows and sends decisions to the same host owner. */
export async function runHostCliSession(options: HostCliSessionOptions): Promise<void> {
  const { client, threadId, output } = options;
  const view = new CommittedThreadView(threadId);
  const completion = Promise.withResolvers<void>();
  // A disconnect can happen while the initial subscribe/start request is pending.
  completion.promise.catch(() => undefined);
  let runId = options.runId;
  let initialized = false;
  let printedSeq = 0;
  let finished = false;
  let responding: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let displayedApproval: string | undefined;
  let pending: PendingHostApproval | undefined;
  let stopRequested = false;
  let connectionClosed = false;
  const finish = (cause?: unknown): void => {
    if (finished) {
      return;
    }
    finished = true;
    if (cause === undefined) {
      completion.resolve();
    } else {
      completion.reject(cause);
    }
  };
  const terminal = options.interactive
    ? createInterface({ input: process.stdin, output: process.stderr })
    : undefined;
  const printRows = (rows: readonly HostLogRow[]): void => {
    for (const row of rows) {
      if (row.seq <= printedSeq) {
        continue;
      }
      printedSeq = row.seq;
      if (options.json || ('runId' in row.event && row.event.runId === runId)) {
        displayRow(row, output, options.json);
      }
    }
  };
  const showApproval = (approval: PendingHostApproval): void => {
    if (!terminal) {
      finish(
        new HostCliExitError(
          'Run awaits a committed decision; attach interactively or use interaction respond.',
          2
        )
      );
      return;
    }
    if (approval.interactionId !== displayedApproval) {
      displayedApproval = approval.interactionId;
      process.stderr.write(
        `\n${approval.toolId} ${JSON.stringify(approval.input)}\nApprove, deny, or stop? `
      );
    }
  };
  const update = (): void => {
    if (!(initialized && !finished)) {
      return;
    }
    const rows = view.getSnapshot();
    const runs = foldHostRuns(rows);
    runId ??= runs.at(-1)?.runId;
    const run = runs.find((item) => item.runId === runId);
    printRows(rows);
    pending = run?.approvals[0];
    if (pending) {
      showApproval(pending);
    }
    if (run && run.status !== 'running') {
      finish(
        run.status === 'failed' || run.status === 'interrupted'
          ? new HostCliExitError(`Run ${run.status}; inspect its committed log.`, 1)
          : undefined
      );
    }
  };
  const accept = (rows: readonly HostLogRow[]): void => {
    view.accept(rows);
    update();
  };
  const stop = (): void => {
    if (!options.startRun) {
      finish();
      return;
    }
    stopRequested = true;
    if (!runId) {
      return;
    }
    stopping ??= client
      .request('run/stop', { commandId: randomUUID(), runId, threadId })
      .then(() => finish(), finish);
  };
  const line = (answer: string): void => {
    const decision = answer.trim().toLowerCase();
    if (decision === 'stop') {
      if (!runId) {
        process.stderr.write('No run is selected.\n');
        return;
      }
      stopping ??= client
        .request('run/stop', { commandId: randomUUID(), runId, threadId })
        .then(() => finish(), finish);
      return;
    }
    if (!(pending && runId) || responding) {
      process.stderr.write('No unanswered decision is selected.\n');
      return;
    }
    if (decision !== 'approve' && decision !== 'deny') {
      process.stderr.write('Enter approve, deny, or stop.\n');
      return;
    }
    responding = client
      .request('interaction/respond', {
        commandId: randomUUID(),
        decision,
        interactionId: pending.interactionId,
        runId,
        threadId,
      })
      .then(() => undefined, finish)
      .finally(() => {
        responding = undefined;
        update();
      });
  };
  const eof = (): void => {
    finish(
      new HostCliExitError(
        'Terminal input closed; the host retains any active run or unanswered decision.',
        2
      )
    );
  };
  terminal?.on('line', line);
  terminal?.once('close', eof);
  const release = client.onEvent((row) => accept([row]));
  const disconnected = (): void => {
    connectionClosed = true;
    finish(new HostCliExitError('Host connection closed before terminal completion.', 1));
  };
  client.closed.then(disconnected, disconnected);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    accept((await client.request('log/subscribe', { fromSeq: 0, threadId })).rows);
    if (finished || stopRequested) {
      finish();
      await completion.promise;
      return;
    }
    if (options.startRun) {
      ({ runId } = await options.startRun());
      if (options.json) {
        output.write(`${JSON.stringify({ runId, threadId })}\n`);
      } else {
        process.stderr.write(`Thread ${threadId}; run ${runId}\n`);
      }
      if (stopRequested) {
        stop();
      }
    }
    initialized = true;
    update();
    await completion.promise;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    terminal?.off('line', line);
    terminal?.off('close', eof);
    terminal?.close();
    release();
    await responding;
    await stopping;
    if (!connectionClosed) {
      await client.request('log/unsubscribe', { threadId });
    }
  }
}
