#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { launchHost } from '@brainstrike/host-lease';
import { attachAgentHost, type HostClient } from './client.js';

export interface HostCliOutput {
  write(value: string): void;
}
function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing --${name}`);
  }
  return value;
}

/** CLI is a client of the root owner; it never runs a second model/tool loop. */
export async function runHostCli(
  args: string[],
  output: HostCliOutput = process.stdout
): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    args,
    options: {
      'command-id': { type: 'string' },
      decision: { type: 'string' },
      'from-seq': { type: 'string' },
      interaction: { type: 'string' },
      model: { type: 'string' },
      prompt: { type: 'string' },
      root: { type: 'string' },
      run: { type: 'string' },
      thread: { type: 'string' },
    },
    strict: true,
  });
  const attachment = await launchHost(resolve(required(values.root, 'root')), {
    attach: attachAgentHost,
    lifetime: 'cli',
    spawn: async () => {
      throw new Error('No M3 host is running for this root; start its configured host first');
    },
  });
  // This launcher has exactly one supplied attachment implementation.
  const client = attachment as HostClient;
  const commandId = values['command-id'] ?? randomUUID();
  const print = (value: unknown): void => {
    output.write(`${JSON.stringify(value)}\n`);
  };
  const threadId = (): string => required(values.thread, 'thread');
  const runId = (): string => required(values.run, 'run');
  try {
    switch (positionals.join(' ')) {
      case 'thread start':
        print(await client.request('thread/start', { commandId }));
        break;
      case 'thread read':
        print(
          await client.request('thread/read', {
            fromSeq: Number(values['from-seq'] ?? 0),
            threadId: threadId(),
          })
        );
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
        try {
          for (const row of (
            await client.request('log/subscribe', { fromSeq: cursor, threadId: selected })
          ).rows) {
            accept(row);
          }
          await client.closed;
        } finally {
          release();
        }
        break;
      }
      default:
        throw new Error(
          'Expected thread start/read, run start/stop, interaction respond, or log follow'
        );
    }
  } finally {
    await client.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runHostCli(process.argv.slice(2)).catch((cause: unknown) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}
