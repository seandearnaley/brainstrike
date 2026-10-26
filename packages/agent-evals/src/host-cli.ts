/**
 * The installed standalone `brainstrike` CLI over one eval's disposable data
 * root and workspace: the real bin, HostCore, tools and storage. Each command
 * runs its host in its own process. The committed log is read back through
 * the CLI (`threads show`) as any client reads it.
 */
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HOST_RESULT_SCHEMAS, type HostLogRow } from '@brainstrike/agent-host/protocol';
import { Schema } from 'effect';
import { type CommandResult, runCommand } from './sandbox.ts';

const require = createRequire(import.meta.url);
const BIN = join(
  dirname(require.resolve('@brainstrike/host-capabilities')),
  '../bin/brainstrike.mjs'
);
const decodeThread = Schema.decodeUnknownSync(HOST_RESULT_SCHEMAS['thread/read'], {
  errors: 'all',
  onExcessProperty: 'error',
});
const RunIdentity = Schema.Struct({ runId: Schema.String, threadId: Schema.String });
const decodeRunIdentity = Schema.decodeUnknownSync(RunIdentity);
/** Each CLI command other than a run's own wait. */
const COMMAND_TIMEOUT_MS = 60_000;

export interface EvalHost {
  readonly cli: (args: readonly string[], timeoutMs?: number) => Promise<CommandResult>;
  readonly rows: (threadId: string) => Promise<readonly HostLogRow[]>;
}

function described(args: readonly string[], result: CommandResult): string {
  const why = result.timedOut ? 'timed out' : `exited ${result.code ?? result.signal}`;
  const command = [args[0], args[1]].filter(Boolean).join(' ');
  return `brainstrike ${command} ${why}: ${result.output.trim()}`;
}

/** The CLI over `dataRoot`, each command's host launched with `workspace` as its root. */
export function startEvalHost(options: {
  readonly dataRoot: string;
  readonly env: Readonly<Record<string, string>>;
  /** A trusted composition module (scripted mode); the bin's own platform otherwise. */
  readonly platformModule?: string;
  readonly workspace: string;
}): EvalHost {
  const launch = [
    '--workspace',
    options.workspace,
    ...(options.platformModule ? ['--platform', options.platformModule] : []),
  ];
  const cli = (args: readonly string[], timeoutMs = COMMAND_TIMEOUT_MS) =>
    runCommand(process.execPath, [BIN, '--data-root', options.dataRoot, ...args, ...launch], {
      cwd: tmpdir(),
      env: options.env,
      timeoutMs,
    });
  return {
    cli,
    rows: async (threadId) => {
      const shown = await cli(['threads', 'show', '--thread', threadId]);
      if (shown.code !== 0) {
        throw new Error(described(['threads', 'show'], shown));
      }
      return decodeThread(JSON.parse(shown.stdout)).rows;
    },
  };
}

export type DrivenRun =
  | { readonly runId: string; readonly threadId: string; readonly status: 'ended' }
  | { readonly runId: string; readonly status: 'timed-out'; readonly threadId: string }
  | {
      readonly error: string;
      readonly status: 'error';
      readonly runId?: string;
      readonly threadId?: string;
    };

/** The first stdout line of `run`/`attach --json`: the run's identity. */
function runIdentity(result: CommandResult): { runId: string; threadId: string } | undefined {
  const [first] = result.stdout.split('\n');
  if (!first) {
    return;
  }
  try {
    return decodeRunIdentity(JSON.parse(first));
  } catch {
    return;
  }
}

/** Interaction requests of `runId` that no response has answered yet. */
function pendingInteractions(rows: readonly HostLogRow[], runId: string) {
  const answered = new Set(
    rows.flatMap((row) =>
      row.event.type === 'interaction.responded' && row.event.runId === runId
        ? [row.event.interactionId]
        : []
    )
  );
  return rows.flatMap((row) =>
    row.event.type === 'interaction.requested' &&
    row.event.runId === runId &&
    !answered.has(row.event.interactionId)
      ? [row.event]
      : []
  );
}

/** Approves each interaction through the CLI; the reason the first answer was refused, if any. */
async function approveAll(
  host: EvalHost,
  threadId: string,
  runId: string,
  pending: readonly { readonly interactionId: string }[],
  remaining: () => number
): Promise<string | undefined> {
  for (const interaction of pending) {
    const respond = [
      'interaction',
      'respond',
      '--thread',
      threadId,
      '--run',
      runId,
      '--interaction',
      interaction.interactionId,
      '--decision',
      'approve',
    ];
    const responded = await host.cli(respond, remaining());
    // 0, 1 and 2: the answer was taken and the resumed run ended or paused again.
    if (responded.timedOut || ![0, 1, 2].includes(responded.code ?? -1)) {
      return described(respond, responded);
    }
  }
  return undefined;
}

/**
 * `run --non-interactive` runs until the run ends (exit 0 or 1) or pauses at
 * an interaction (exit 2). Each pause is an approval the eval grants through
 * the CLI's own mechanism, `interaction respond --decision approve`, which
 * follows the resumed run until it ends or pauses again; `attach` then reads
 * where it stands. Any other interaction (a question, a plan, network
 * consent) has no scripted answer, so it ends the attempt with a reason.
 */
export async function driveEvalRun(
  host: EvalHost,
  options: { readonly modelId: string; readonly prompt: string; readonly timeoutMs: number }
): Promise<DrivenRun> {
  const deadline = Date.now() + options.timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const args = ['run', options.prompt, '--model', options.modelId, '--json', '--non-interactive'];
  let result = await host.cli(args, remaining());
  const identity = runIdentity(result);
  if (!identity) {
    return { error: described(args, result), status: 'error' };
  }
  const { runId, threadId } = identity;
  for (;;) {
    if (result.timedOut) {
      // The CLI's signal already stopped the run; its log says so.
      return { runId, status: 'timed-out', threadId };
    }
    if (result.code !== 2) {
      // 0 and 1 both end the run: its committed verdict, not the exit code, is scored.
      return result.code === 0 || result.code === 1
        ? { runId, status: 'ended', threadId }
        : { error: described(args, result), runId, status: 'error', threadId };
    }
    const pending = pendingInteractions(await host.rows(threadId), runId);
    if (pending.length === 0) {
      return {
        error: `The run paused (exit 2) with no pending interaction: ${result.output.trim()}`,
        runId,
        status: 'error',
        threadId,
      };
    }
    const unanswerable = pending.find((interaction) => interaction.kind !== 'approval');
    if (unanswerable) {
      return {
        error: `The run asked for a ${unanswerable.kind} interaction (${unanswerable.toolId}), which an eval cannot answer`,
        runId,
        status: 'error',
        threadId,
      };
    }
    const refused = await approveAll(host, threadId, runId, pending, remaining);
    if (refused) {
      return { error: refused, runId, status: 'error', threadId };
    }
    result = await host.cli(
      ['attach', '--thread', threadId, '--run', runId, '--json', '--non-interactive'],
      remaining()
    );
  }
}
