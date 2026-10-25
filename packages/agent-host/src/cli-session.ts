import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Schema } from 'effect';
import type { HostCliOutput } from './cli.ts';
import { readCliMcpInput, settleCliMcpInput } from './cli-mcp-input.ts';
import type { HostClient } from './client.ts';
import type { HostLogRow, HostRunTelemetry } from './protocol.ts';
import {
  CommittedThreadView,
  committedAssistantText,
  foldHostRuns,
  HostRunNotices,
  type HostRunView,
  isHostStepStart,
  type PendingHostApproval,
} from './thread-view.ts';

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
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.exitCode = exitCode;
    this.name = 'HostCliExitError';
  }
}
export interface HostCliSessionOptions {
  readonly client: HostClient;
  readonly interactive: boolean;
  readonly json: boolean;
  readonly output: HostCliOutput;
  readonly runId?: string;
  readonly startRun?: () => Promise<{
    runId: string;
  }>;
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
  let mcpInput: string | undefined;
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
  // An MCP server's input lives only in this command's host, so this terminal answers it.
  const showMcpInput = (interactionId: string): void => {
    if (!(terminal && runId)) {
      finish(
        new HostCliExitError(
          'Run awaits MCP input; run it in an interactive terminal to answer.',
          2
        )
      );
      return;
    }
    if (interactionId === displayedMcpInput) {
      return;
    }
    displayedMcpInput = interactionId;
    const address = { interactionId, runId, threadId };
    responding ??= readCliMcpInput(client, address)
      .then(
        (input) => {
          process.stderr.write(
            `\nMCP input requested: ${JSON.stringify(input)}\nAnswer with JSON {"action":"accept","content":{...}}, {"action":"decline"} or {"action":"cancel"}, or stop: `
          );
        },
        (cause: unknown) => {
          process.stderr.write(`MCP input unavailable: ${errorText(cause)}\n`);
        }
      )
      .finally(() => {
        responding = undefined;
      });
  };
  const settleMcpInput = (interactionId: string, answer: string): void => {
    if (!runId) {
      return;
    }
    let action: string;
    let content: string | undefined;
    try {
      const parsed = Schema.decodeUnknownSync(
        Schema.Struct({ action: Schema.String, content: Schema.optional(Schema.MutableJson) }),
        { errors: 'all', onExcessProperty: 'error' }
      )(JSON.parse(answer));
      action = parsed.action;
      content = parsed.content === undefined ? undefined : JSON.stringify(parsed.content);
    } catch (cause) {
      process.stderr.write(`Invalid JSON response: ${errorText(cause)}\n`);
      return;
    }
    responding = settleCliMcpInput(
      client,
      { interactionId, runId, threadId },
      { action, commandId: randomUUID(), content }
    )
      .then(
        () => undefined,
        (cause: unknown) => {
          process.stderr.write(`MCP input rejected: ${errorText(cause)}\n`);
          displayedMcpInput = undefined;
        }
      )
      .finally(() => {
        responding = undefined;
        update();
      });
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
    mcpInput = run?.status === 'running' ? pendingMcpInput(rows, runId) : undefined;
    if (mcpInput) {
      showMcpInput(mcpInput);
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
  /** The host request that answers `interaction`, or nothing when `answer` is not an answer. */
  const answerInteraction = (
    interaction: PendingHostApproval,
    selectedRun: string,
    answer: string
  ): Promise<unknown> | undefined => {
    if (interaction.kind !== 'approval') {
      let resumeData: typeof Schema.MutableJson.Type;
      try {
        resumeData = Schema.decodeUnknownSync(Schema.MutableJson, {
          errors: 'all',
          onExcessProperty: 'error',
        })(JSON.parse(answer));
      } catch (cause) {
        process.stderr.write(`Invalid JSON response: ${errorText(cause)}\n`);
        return undefined;
      }
      return client.request('interaction/resume', {
        commandId: randomUUID(),
        interactionId: interaction.interactionId,
        resumeData,
        runId: selectedRun,
        threadId,
      });
    }
    const decision = answer.trim().toLowerCase();
    if (decision !== 'approve' && decision !== 'deny') {
      process.stderr.write('Enter approve, deny, or stop.\n');
      return undefined;
    }
    return client.request('interaction/respond', {
      commandId: randomUUID(),
      decision,
      interactionId: interaction.interactionId,
      runId: selectedRun,
      threadId,
    });
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
    if (!pending && mcpInput && responding === undefined) {
      settleMcpInput(mcpInput, answer);
      return;
    }
    if (!(pending && runId) || responding !== undefined) {
      process.stderr.write('No unanswered decision is selected.\n');
      return;
    }
    const request = answerInteraction(pending, runId, answer);
    if (!request) {
      return;
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
        'Terminal input closed; a running run is interrupted, and an unanswered decision stays for attach.',
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
