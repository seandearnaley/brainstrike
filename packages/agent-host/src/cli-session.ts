import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import type { HostCliOutput } from './cli.js';
import type { HostClient } from './client.js';
import type { HostLogRow } from './protocol.js';
import {
  CommittedThreadView,
  foldHostRuns,
  type PendingHostApproval,
  type PendingHostInput,
} from './thread-view.js';

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const INPUT_ANSWER = /^(accept|decline|cancel)(?:\s+(.+))?$/su;

/**
 * A terminal answer to committed MCP input, as the presenter's settlement:
 * `accept {...}` (form content), `accept` (URL), `decline` or `cancel`.
 */
export function hostInputSettlement(input: PendingHostInput, answer: string): unknown {
  const match = INPUT_ANSWER.exec(answer.trim());
  const action = match?.[1];
  const content = match?.[2];
  const { presentation } = input;
  if (!action) {
    throw new Error('Enter accept, decline, cancel, or stop.');
  }
  if (action !== 'accept' && content !== undefined) {
    throw new Error(`${action} takes no content.`);
  }
  if (action === 'accept' && (presentation.mode === 'form') !== (content !== undefined)) {
    throw new Error(
      presentation.mode === 'form'
        ? 'accept needs the form content as a JSON object.'
        : 'A URL request takes no content.'
    );
  }
  return {
    action,
    configuredServerId: presentation.provenance.configuredServerId,
    ...(content === undefined ? {} : { content: JSON.parse(content) as unknown }),
    generation: presentation.provenance.generation,
    id: presentation.id,
    requestId: presentation.provenance.requestId,
  };
}

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

/** Sends a terminal answer to committed MCP input; nothing when the answer is unusable. */
function settleHostInput(
  client: HostClient,
  threadId: string,
  input: PendingHostInput,
  answer: string
): Promise<unknown> | undefined {
  let settlement: unknown;
  try {
    settlement = hostInputSettlement(input, answer);
  } catch (cause) {
    process.stderr.write(`${errorText(cause)}\n`);
    return;
  }
  return client.request('input/settle', {
    runId: input.runId,
    settlement: z.json().parse(settlement),
    threadId,
    toolCallId: input.toolCallId,
  });
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
  let pendingInput: PendingHostInput | undefined;
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
          'Run awaits a committed interaction; attach interactively or use interaction respond/resume.',
          2
        )
      );
      return;
    }
    if (approval.interactionId !== displayedApproval) {
      displayedApproval = approval.interactionId;
      process.stderr.write(
        `\n${approval.toolId} ${JSON.stringify(approval.input)}\n${
          approval.kind === 'approval'
            ? 'Approve, deny, or stop? '
            : approval.kind === 'question'
              ? 'Answer with JSON {"answer":"text"} or {"answer":["choice"]}, or stop: '
              : 'Decide with JSON {"action":"approved"|"rejected","feedback":"optional text"}, or stop: '
        }`
      );
    }
  };
  const showInput = (input: PendingHostInput): void => {
    if (!terminal) {
      finish(
        new HostCliExitError(
          'Run awaits committed MCP server input; attach interactively or use input settle.',
          2
        )
      );
      return;
    }
    if (input.inputId === displayedApproval) {
      return;
    }
    displayedApproval = input.inputId;
    const { presentation } = input;
    process.stderr.write(
      `\nMCP server ${presentation.provenance.configuredServerId} asks: ${presentation.message}\n${
        presentation.mode === 'url'
          ? `${presentation.url}\nAccept, decline, cancel, or stop? `
          : `${JSON.stringify(presentation.requestedSchema)}\nAnswer with accept {"field":value}, decline, cancel, or stop: `
      }`
    );
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
    pendingInput = pending ? undefined : run?.inputs[0];
    if (pending) {
      showApproval(pending);
    } else if (pendingInput) {
      showInput(pendingInput);
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
  const respond = (request: Promise<unknown>): void => {
    responding = request
      .then(
        () => undefined,
        (cause: unknown) => {
          process.stderr.write(`Interaction rejected: ${errorText(cause)}\n`);
          displayedApproval = undefined;
        }
      )
      .finally(() => {
        responding = undefined;
        update();
      });
  };
  /** Committed MCP server input is answered when no approval is pending. */
  const answerInput = (answer: string): boolean => {
    if (!pendingInput || pending || responding) {
      return false;
    }
    const request = settleHostInput(client, threadId, pendingInput, answer);
    if (request) {
      respond(request);
    }
    return true;
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
    if (answerInput(answer)) {
      return;
    }
    if (!(pending && runId) || responding) {
      process.stderr.write('No unanswered decision is selected.\n');
      return;
    }
    const interaction = pending;
    let request: Promise<unknown>;
    if (interaction.kind !== 'approval') {
      let resumeData: z.infer<ReturnType<typeof z.json>>;
      try {
        resumeData = z.json().parse(JSON.parse(answer));
      } catch (cause) {
        process.stderr.write(`Invalid JSON response: ${errorText(cause)}\n`);
        return;
      }
      request = client.request('interaction/resume', {
        commandId: randomUUID(),
        interactionId: interaction.interactionId,
        resumeData,
        runId,
        threadId,
      });
    } else if (decision !== 'approve' && decision !== 'deny') {
      process.stderr.write('Enter approve, deny, or stop.\n');
      return;
    } else {
      request = client.request('interaction/respond', {
        commandId: randomUUID(),
        decision,
        interactionId: interaction.interactionId,
        runId,
        threadId,
      });
    }
    respond(request);
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
