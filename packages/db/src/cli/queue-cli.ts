#!/usr/bin/env node
import { createLogger } from '@brainstrike/utils';
import type { JobState } from '../queue/job-queue.js';
import { JobQueue } from '../queue/job-queue.js';
/*
 Simple dev CLI for inspecting and managing the job_queue.
 Usage examples:
   node dist/cli/queue-cli.js stats --queue embeddings --db memory://
   node dist/cli/queue-cli.js requeue --queue embeddings --limit 20 --db memory://
   node dist/cli/queue-cli.js clear --queue embeddings --states failed queued --db memory://
*/
import { wasmLoader } from '../wasm-loader.js';

const logger = createLogger('QueueCli');

interface Args {
  cmd: 'stats' | 'requeue' | 'clear' | 'prune' | 'help';
  db?: string;
  limit?: number;
  olderThan?: string;
  queue?: string;
  states?: string[];
}

function parseStates(tokens: string[], start: number): { values: string[]; next: number } {
  const values: string[] = [];
  let i = start;
  while (i < tokens.length && !String(tokens[i]).startsWith('--')) {
    values.push(String(tokens[i]));
    i++;
  }
  return { next: i - 1, values };
}

function parseArgs(argv: string[]): Args {
  const out: Args = { cmd: 'help' } as Args;
  const [cmd, ...rest] = argv;
  out.cmd = (cmd as Args['cmd']) || 'help';

  for (let i = 0; i < rest.length; i++) {
    const a = String(rest[i] ?? '');
    switch (true) {
      case a === '--queue':
        out.queue = String(rest[++i] ?? '');
        break;
      case a.startsWith('--queue='):
        out.queue = String(a.split('=')[1] ?? '');
        break;
      case a === '--limit':
        out.limit = Number(String(rest[++i] ?? ''));
        break;
      case a.startsWith('--limit='):
        out.limit = Number(String(a.split('=')[1] ?? ''));
        break;
      case a === '--db':
        out.db = String(rest[++i] ?? '');
        break;
      case a.startsWith('--db='):
        out.db = String(a.split('=')[1] ?? '');
        break;
      case a === '--states': {
        const { values, next } = parseStates(rest, i + 1);
        out.states = values;
        i = next;
        break;
      }
      case a === '--olderThan':
        out.olderThan = String(rest[++i] ?? '');
        break;
      case a.startsWith('--olderThan='):
        out.olderThan = String(a.split('=')[1] ?? '');
        break;
      default:
        break;
    }
  }
  return out;
}

function writeInfo(message: string): void {
  logger.info(message);
  process.stdout.write(`${message}\n`);
}

function writeJson(label: string, payload: unknown): void {
  logger.info(label, { payload });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function writeError(message: string, error?: unknown): void {
  logger.error(message, { error });
  process.stderr.write(`${message}\n`);
}

function printHelp() {
  writeInfo(
    'Usage: queue-cli <stats|requeue|clear|prune> [--queue embeddings] [--limit 20] [--db memory://] [--states failed queued] [--olderThan 2025-01-01T00:00:00Z]'
  );
}

async function executeStats(jq: JobQueue, queue?: string) {
  const stats = await jq.getQueueStats(queue);
  writeJson('queue-stats', { queue, stats });
}

async function executeRequeue(jq: JobQueue, queue?: string, limit = 20) {
  const moved = await jq.requeueFailed(queue, limit);
  writeInfo(`Requeued ${moved} failed jobs${queue ? ` in queue '${queue}'` : ''}.`);
}

function sanitizeStates(states?: string[]): JobState[] | undefined {
  if (!states || states.length === 0) {
    return;
  }
  const allowed: JobState[] = ['queued', 'running', 'succeeded', 'failed', 'canceled', 'expired'];
  return states.filter((s): s is JobState => (allowed as string[]).includes(s));
}

async function executeClear(jq: JobQueue, queue?: string, states?: string[]) {
  const safeStates = sanitizeStates(states);
  const deleted = await jq.clear(queue, safeStates);
  writeInfo(
    `Deleted ${deleted} jobs${queue ? ` in queue '${queue}'` : ''}${
      safeStates ? ` with states [${safeStates.join(',')}]` : ''
    }.`
  );
}

async function executePrune(jq: JobQueue, states?: string[], olderThan?: string) {
  if (!olderThan) {
    writeError('prune requires --olderThan ISO timestamp');
    process.exit(2);
  }
  const safeStates = sanitizeStates(states) ?? ['succeeded', 'failed'];
  const deleted = await jq.prune(safeStates, olderThan);
  writeInfo(
    `Pruned ${deleted} jobs with states [${safeStates.join(',')}] older than ${olderThan}.`
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args.cmd === 'help' || !['stats', 'requeue', 'clear', 'prune'].includes(args.cmd)) {
    printHelp();
    process.exit(0);
  }

  const dbPath = args.db || 'memory://';
  const db = await wasmLoader.createPGlite(dbPath);
  const jq = new JobQueue(db);

  switch (args.cmd) {
    case 'stats':
      await executeStats(jq, args.queue);
      break;
    case 'requeue':
      await executeRequeue(jq, args.queue, Number.isFinite(args.limit) ? args.limit : 20);
      break;
    case 'clear':
      await executeClear(jq, args.queue, args.states);
      break;
    case 'prune':
      await executePrune(jq, args.states, args.olderThan);
      break;
    default:
      printHelp();
      break;
  }
}

// eslint-disable-next-line unicorn/prefer-top-level-await
main().catch((err) => {
  writeError('queue-cli error', err);
  process.exit(1);
});
