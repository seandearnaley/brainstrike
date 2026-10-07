#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { launchHost } from '@brainstrike/host-lease';
import { HostCliExitError, runHostCliSession } from './cli-session.js';
import { attachAgentHost, type HostClient } from './client.js';
import { createAgentHostSpawner } from './launcher.js';
import { isProcessEntrypoint } from './process-entrypoint.js';

export interface HostCliOutput {
  write(value: string): void;
}
function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing --${name}`);
  }
  return value;
}

type CliStringOption =
  | 'command-id'
  | 'data-root'
  | 'decision'
  | 'from-seq'
  | 'interaction'
  | 'model'
  | 'platform'
  | 'prompt'
  | 'root'
  | 'run'
  | 'thread';
type CliBooleanOption = 'help' | 'interactive' | 'json' | 'non-interactive';
interface HostCliArguments {
  readonly command: string;
  readonly interactive: boolean;
  readonly positionals: readonly string[];
  readonly values: Partial<Record<CliStringOption, string> & Record<CliBooleanOption, boolean>>;
}

function parseHostCliArgs(args: string[]): HostCliArguments {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    args,
    options: {
      'command-id': { type: 'string' },
      'data-root': { type: 'string' },
      decision: { type: 'string' },
      'from-seq': { type: 'string' },
      help: { type: 'boolean' },
      interaction: { type: 'string' },
      interactive: { type: 'boolean' },
      json: { type: 'boolean' },
      model: { type: 'string' },
      'non-interactive': { type: 'boolean' },
      platform: { type: 'string' },
      prompt: { type: 'string' },
      root: { type: 'string' },
      run: { type: 'string' },
      thread: { type: 'string' },
    },
    strict: true,
  });
  const ordinaryRun = positionals[0] === 'run' && !['start', 'stop'].includes(positionals[1] ?? '');
  const command = values.help ? 'help' : ordinaryRun ? 'run' : positionals.join(' ');
  if (
    ![
      'host start',
      'host status',
      'help',
      'thread start',
      'thread read',
      'threads list',
      'threads show',
      'run',
      'attach',
      'run start',
      'run stop',
      'interaction respond',
      'log follow',
    ].includes(command)
  ) {
    throw new Error('Unknown host command');
  }
  if (values.root && values['data-root'] && resolve(values.root) !== resolve(values['data-root'])) {
    throw new Error('--root and --data-root must select the same data root');
  }
  if (values.interactive && values['non-interactive']) {
    throw new Error('Choose interactive or non-interactive input');
  }
  return {
    command,
    interactive: !values['non-interactive'] && (values.interactive ?? Boolean(process.stdin.isTTY)),
    positionals,
    values,
  };
}

/** CLI is a client of the root owner; it never runs a second model/tool loop. */
export async function runHostCli(
  args: string[],
  output: HostCliOutput = process.stdout
): Promise<void> {
  const { command, interactive, positionals, values } = parseHostCliArgs(args);
  if (command === 'help') {
    output.write(`brainstrike --data-root <path> [--platform <module>] <command>

run "prompt" --model <id> [--thread <id>] [--json] [--non-interactive]
attach --thread <id> [--run <id>] [--json] [--interactive]
threads list
threads show --thread <id> [--from-seq <n>]
host start | host status
thread start | thread read --thread <id>
run start --thread <id> --model <id> --prompt <text>
run stop --thread <id> --run <id>
interaction respond --thread <id> --run <id> --interaction <id> --decision approve|deny
log follow --thread <id> [--from-seq <n>]

Starting a host currently requires its configured --platform module.
Unanswered noninteractive decisions exit 2 and remain available for attach.
An interactive terminal accepts approve, deny, or stop. EOF detaches.
Run signals stop and join its execution; attach signals detach.
`);
    return;
  }
  const attachment = await launchHost(
    resolve(required(values['data-root'] ?? values.root, 'data-root')),
    {
      attach: attachAgentHost,
      lifetime: command === 'host start' ? 'persistent' : 'cli',
      spawn: (options, signal) => {
        if (command === 'host status') {
          throw new Error('No host is running for this root');
        }
        return createAgentHostSpawner(required(values.platform, 'platform'))(options, signal);
      },
    }
  );
  // This launcher has exactly one supplied attachment implementation.
  const client = attachment as HostClient;
  const commandId = values['command-id'] ?? randomUUID();
  const print = (value: unknown): void => {
    output.write(`${JSON.stringify(value)}\n`);
  };
  const threadId = (): string => required(values.thread, 'thread');
  const runId = (): string => required(values.run, 'run');
  try {
    switch (command) {
      case 'host start':
      case 'host status': {
        const { hostVersion, pid, protocolVersion, start } = client.record;
        print({ hostVersion, pid, protocolVersion, start });
        break;
      }
      case 'thread start':
        print(await client.request('thread/start', { commandId }));
        break;
      case 'threads list':
        print(await client.request('thread/list', {}));
        break;
      case 'thread read':
      case 'threads show':
        print(
          await client.request('thread/read', {
            fromSeq: Number(values['from-seq'] ?? 0),
            threadId: threadId(),
          })
        );
        break;
      case 'run': {
        const modelId = required(values.model, 'model');
        const prompt = required(values.prompt ?? positionals.slice(1).join(' '), 'prompt');
        const selected =
          values.thread ??
          (await client.request('thread/start', { commandId: randomUUID() })).threadId;
        await runHostCliSession({
          client,
          interactive,
          json: values.json ?? false,
          output,
          startRun: () =>
            client.request('run/start', {
              commandId,
              modelId,
              prompt,
              threadId: selected,
            }),
          threadId: selected,
        });
        break;
      }
      case 'attach':
        await runHostCliSession({
          client,
          interactive,
          json: values.json ?? false,
          output,
          ...(values.run ? { runId: values.run } : {}),
          threadId: threadId(),
        });
        break;
      case 'run start':
        print(
          await client.request('run/start', {
            commandId,
            modelId: required(values.model, 'model'),
            prompt: required(values.prompt, 'prompt'),
            threadId: threadId(),
          })
        );
        break;
      case 'run stop':
        print(
          await client.request('run/stop', { commandId, runId: runId(), threadId: threadId() })
        );
        break;
      case 'interaction respond': {
        const decision = values.decision;
        if (decision !== 'approve' && decision !== 'deny') {
          throw new Error('--decision must be approve or deny');
        }
        print(
          await client.request('interaction/respond', {
            commandId,
            decision,
            interactionId: required(values.interaction, 'interaction'),
            runId: runId(),
            threadId: threadId(),
          })
        );
        break;
      }
      case 'log follow': {
        const selected = threadId();
        const rows = new Map<number, unknown>();
        let cursor = Number(values['from-seq'] ?? 0);
        const accept = (row: { threadId: string; seq: number }): void => {
          if (row.threadId !== selected || row.seq <= cursor) {
            return;
          }
          rows.set(row.seq, row);
          while (rows.has(cursor + 1)) {
            cursor += 1;
            print(rows.get(cursor));
            rows.delete(cursor);
          }
        };
        const release = client.onEvent(accept);
        const detach = (): void => {
          void client.close();
        };
        process.once('SIGINT', detach);
        process.once('SIGTERM', detach);
        try {
          for (const row of (
            await client.request('log/subscribe', { fromSeq: cursor, threadId: selected })
          ).rows) {
            accept(row);
          }
          await client.closed;
        } finally {
          release();
          process.off('SIGINT', detach);
          process.off('SIGTERM', detach);
        }
        break;
      }
      default:
        throw new Error(
          'Expected host start/status, thread start/read, run start/stop, interaction respond, or log follow'
        );
    }
  } finally {
    await client.close();
  }
}

/** Both installed executable names and the direct Node entry share exit semantics. */
export async function runHostCliProcess(args: string[]): Promise<void> {
  try {
    await runHostCli(args);
  } catch (cause: unknown) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = cause instanceof HostCliExitError ? cause.exitCode : 1;
  }
}

if (isProcessEntrypoint(import.meta.url)) {
  void runHostCliProcess(process.argv.slice(2));
}
