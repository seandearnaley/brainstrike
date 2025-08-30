#!/usr/bin/env node
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

type Args = {
  cmd: 'stats' | 'requeue' | 'clear' | 'prune' | 'help';
  queue?: string;
  limit?: number;
  db?: string;
  states?: string[];
  olderThan?: string;
};

function parseStates(tokens: string[], start: number): { values: string[]; next: number } {
  const values: string[] = [];
  let i = start;
  while (i < tokens.length && !String(tokens[i]).startsWith('--')) {
    values.push(String(tokens[i]));
    i++;
  }
  return { values, next: i - 1 };
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

function printHelp() {
  console.log(
    'Usage: queue-cli <stats|requeue|clear|prune> [--queue embeddings] [--limit 20] [--db memory://] [--states failed queued] [--olderThan 2025-01-01T00:00:00Z]'
  );
}

async function executeStats(jq: JobQueue, queue?: string) {
  const stats = await jq.getQueueStats(queue);
  console.log(JSON.stringify(stats, null, 2));
}

async function executeRequeue(jq: JobQueue, queue?: string, limit = 20) {
  const moved = await jq.requeueFailed(queue, limit);
  console.log(`Requeued ${moved} failed jobs${queue ? ` in queue '${queue}'` : ''}.`);
}

function sanitizeStates(states?: string[]): JobState[] | undefined {
  if (!states || states.length === 0) return undefined;
  const allowed: JobState[] = ['queued', 'running', 'succeeded', 'failed', 'canceled', 'expired'];
  return states.filter((s): s is JobState => (allowed as string[]).includes(s));
}

async function executeClear(jq: JobQueue, queue?: string, states?: string[]) {
  const safeStates = sanitizeStates(states);
  const deleted = await jq.clear(queue, safeStates);
  console.log(
    `Deleted ${deleted} jobs${queue ? ` in queue '${queue}'` : ''}${
      safeStates ? ` with states [${safeStates.join(',')}]` : ''
    }.`
  );
}

async function executePrune(jq: JobQueue, states?: string[], olderThan?: string) {
  if (!olderThan) {
    console.error('prune requires --olderThan ISO timestamp');
    process.exit(2);
  }
  const safeStates = sanitizeStates(states) ?? ['succeeded', 'failed'];
  const deleted = await jq.prune(safeStates, olderThan);
  console.log(
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
  console.error('queue-cli error:', err);
  process.exit(1);
});
