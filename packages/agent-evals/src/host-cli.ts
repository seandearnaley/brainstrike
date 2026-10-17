/**
 * The installed standalone `brainstrike` CLI over one eval's disposable data
 * root and workspace: the real bin, HostCore, tools and storage. The committed
 * log is read back through the CLI (`threads show`) as any client reads it.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HOST_RESULT_SCHEMAS, type HostLogRow } from '@brainstrike/agent-host/protocol';
import { decodeHostRecord } from '@brainstrike/host-lease';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import { Schema } from 'effect';
import { type CommandResult, runCommand } from './sandbox.js';

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
const HOST_EXIT_TIMEOUT_MS = 30_000;

export interface EvalHost {
  readonly cli: (args: readonly string[], timeoutMs?: number) => Promise<CommandResult>;
  /** `host stop`, then waits for the host process to exit. */
  readonly close: () => Promise<void>;
  readonly rows: (threadId: string) => Promise<readonly HostLogRow[]>;
}

function described(args: readonly string[], result: CommandResult): string {
  const why = result.timedOut ? 'timed out' : `exited ${result.code ?? result.signal}`;
  const command = [args[0], args[1]].filter(Boolean).join(' ');
  return `brainstrike ${command} ${why}: ${result.output.trim()}`;
}

/** Starts a standalone host whose launch root is `workspace`. */
export async function startEvalHost(options: {
  readonly dataRoot: string;
  readonly env: Readonly<Record<string, string>>;
  /** A trusted composition module (scripted mode); the bin's own platform otherwise. */
  readonly platformModule?: string;
  readonly workspace: string;
}): Promise<EvalHost> {
  const cli = (args: readonly string[], timeoutMs = COMMAND_TIMEOUT_MS) =>
    runCommand(process.execPath, [BIN, '--data-root', options.dataRoot, ...args], {
      cwd: tmpdir(),
      env: options.env,
      timeoutMs,
    });
  const started = await cli([
    'host',
    'start',
    '--workspace',
    options.workspace,
    ...(options.platformModule ? ['--platform', options.platformModule] : []),
  ]);
  if (started.code !== 0) {
    throw new Error(described(['host', 'start'], started));
  }
  return {
    cli,
    close: async () => {
      const owner = RootLock.inspect(options.dataRoot)?.owner;
      if (!owner || owner.released) {
        return;
      }
      const { pid } = decodeHostRecord(
        JSON.parse(await readFile(join(options.dataRoot, 'host.json'), 'utf8'))
      );
      const stopped = await cli(['host', 'stop']);
      if (stopped.code !== 0) {
        throw new Error(described(['host', 'stop'], stopped));
      }
      const deadline = Date.now() + HOST_EXIT_TIMEOUT_MS;
      while (processStartTime(pid) !== null) {
        if (Date.now() > deadline) {
          throw new Error(`The eval host ${pid} outlived host stop`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
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

/**
 * `run --non-interactive` runs until the run ends (exit 0 or 1) or pauses at
 * an interaction (exit 2). Each pause is an approval the eval grants through
 * the CLI's own mechanism, `interaction respond --decision approve`, then
 * `attach` resumes the wait. Any other interaction (a question, a plan, network
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
      const responded = await host.cli(respond);
      if (responded.code !== 0) {
        return { error: described(respond, responded), runId, status: 'error', threadId };
      }
    }
    result = await host.cli(
      ['attach', '--thread', threadId, '--run', runId, '--json', '--non-interactive'],
      remaining()
    );
  }
}
