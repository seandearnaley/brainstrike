import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import type { HostCliOutput } from './cli.js';
import type { HostClient } from './client.js';
import type { HostLogRow, HostRunTelemetry } from './protocol.js';
import {
  CommittedThreadView,
  committedAssistantText,
  foldHostRuns,
  HostRunNotices,
  type HostRunView,
  isHostStepStart,
  type PendingHostApproval,
} from './thread-view.js';

/** How each committed interaction kind is answered at the prompt. */
const INTERACTION_PROMPTS: Readonly<Record<PendingHostApproval['kind'], string>> = {
  approval: 'Approve, deny, or stop? ',
  network: 'Allow its network with JSON {"action":"allow"|"deny"}, or stop: ',
  plan: 'Decide with JSON {"action":"approved"|"rejected","feedback":"optional text"}, or stop: ',
  question: 'Answer with JSON {"answer":"text"} or {"answer":["choice"]}, or stop: ',
};

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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

/** A failed or interrupted run ends the CLI with its committed detail. */
export function hostRunExitError(run: HostRunView): HostCliExitError | undefined {
  if (run.status !== 'failed' && run.status !== 'interrupted') {
    return;
  }
  return new HostCliExitError(
    run.detail === undefined
      ? `Run ${run.status}; inspect its committed log.`
      : `Run ${run.status}: ${run.detail}`,
    1
  );
}

/** The run's oldest MCP input with neither a committed answer intent nor a settlement. */
function pendingMcpInput(
  rows: readonly HostLogRow[],
  runId: string | undefined
): string | undefined {
  const answered = new Set<string>();
  for (const { event } of rows) {
    if (event.type === 'mcp.input.intent' || event.type === 'mcp.input.settled') {
      answered.add(event.interactionId);
    }
  }
  for (const { event } of rows) {
    if (
      event.type === 'mcp.input.requested' &&
      event.runId === runId &&
      !answered.has(event.interactionId)
    ) {
      return event.interactionId;
    }
  }
  return;
}

/**
 * A run's answer prints once: live from `run/telemetry` text deltas, or, for a
 * step this terminal did not watch (replay, attach), from its committed
 * `model.step` text (ADR-0011 amendment). A Stop's partial reply commits as
 * `model.messages` inside the open step.
 */
class HostCliAnswerText {
  /** Runs whose open step printed live text since its last commit. */
  private readonly printedLive = new Set<string>();
  /** Runs with a committed step start and no step commit yet. */
  private readonly openSteps = new Set<string>();

  live(telemetry: HostRunTelemetry, output: HostCliOutput): void {
    const chunk = telemetry.chunk;
    if (
      chunk &&
      typeof chunk === 'object' &&
      !Array.isArray(chunk) &&
      chunk['type'] === 'text-delta' &&
      typeof chunk['text'] === 'string'
    ) {
      output.write(chunk['text']);
      this.printedLive.add(telemetry.runId);
    }
  }

  committed(row: HostLogRow, output: HostCliOutput): void {
    const event = row.event;
    if (event.type === 'stream.chunk' && isHostStepStart(event.chunk)) {
      this.openSteps.add(event.runId);
      return;
    }
    const stepText =
      event.type === 'model.step' ||
      (event.type === 'model.messages' && this.openSteps.has(event.runId));
    if (!stepText) {
      return;
    }
    this.openSteps.delete(event.runId);
    if (this.printedLive.delete(event.runId)) {
      return;
    }
    output.write(committedAssistantText(event.messages));
  }
}

function displayRow(
  row: HostLogRow,
  output: HostCliOutput,
  json: boolean,
  notices: HostRunNotices,
  answer: HostCliAnswerText
): void {
  if (json) {
    output.write(`${JSON.stringify(row)}\n`);
    return;
  }
  // Warnings and attempt records go beside the answer, like the approval prompt.
  for (const notice of notices.read(row)) {
    process.stderr.write(`\n${notice}\n`);
  }
  const event = row.event;
  answer.committed(row, output);
  if (event.type === 'mcp.tools.unavailable') {
    // A notice beside the output: the run proceeds without this server's tools.
    process.stderr.write(`MCP server ${event.serverId} unavailable: ${event.reason}\n`);
  } else if (event.type === 'effect.finished') {
    output.write(`\n${JSON.stringify(event.output)}\n`);
  } else if (event.type === 'run.finished' || event.type === 'run.attempt') {
    // An ended attempt's partial text stays on its own line.
    output.write('\n');
  }
}

/** The terminal observes committed rows and sends decisions to the same host owner. */
export async function runHostCliSession(options: HostCliSessionOptions): Promise<void> {
  const { client, threadId, output } = options;
  const view = new CommittedThreadView(threadId);
  const notices = new HostRunNotices();
  const answer = new HostCliAnswerText();
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
  let displayedMcpInput: string | undefined;
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
        displayRow(row, output, options.json, notices, answer);
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
        `\n${approval.toolId} ${JSON.stringify(approval.input)}\n${INTERACTION_PROMPTS[approval.kind]}`
      );
    }
  };
  // An MCP server's input is answered with `mcp input read/settle`, from any terminal.
  const showMcpInput = (interactionId: string): void => {
    const settle = `mcp input settle --thread ${threadId} --run ${runId} --interaction ${interactionId}`;
    if (!terminal) {
      finish(
        new HostCliExitError(
          `Run awaits MCP input; read it with mcp input read, then answer: ${settle} --action accept|decline|cancel [--content <json>]`,
          2
        )
      );
      return;
    }
    if (interactionId !== displayedMcpInput) {
      displayedMcpInput = interactionId;
      process.stderr.write(
        `\nMCP input requested. Read it with mcp input read, then answer from another terminal: ${settle} --action accept|decline|cancel [--content <json>]\n`
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
    const input = run?.status === 'running' ? pendingMcpInput(rows, runId) : undefined;
    if (input) {
      showMcpInput(input);
    }
    if (run && run.status !== 'running') {
      finish(hostRunExitError(run));
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
  const releaseTelemetry = client.onTelemetry((telemetry) => {
    if (!options.json && telemetry.threadId === threadId && telemetry.runId === runId) {
      answer.live(telemetry, output);
    }
  });
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
    releaseTelemetry();
    await responding;
    await stopping;
    if (!connectionClosed) {
      await client.request('log/unsubscribe', { threadId });
    }
  }
}
