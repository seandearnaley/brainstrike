/**
 * BST-1875: SIGKILL crash-injection gate for every index access method.
 *
 * The clean-close durability gate (`pg-textsearch-durability-gate`) checkpoints,
 * closes and reopens, so it can never see crash-recovery damage; pg_textsearch
 * 1.3.1's BM25 index was broken on 9 of 15 reopens after a SIGKILL and clean on
 * 30 of 30 with a REINDEX. This gate reproduces that: a child process writes the
 * REAL migrated schema through the PRODUCTION factory and is killed mid-write,
 * then the data dir is reopened, recovered exactly as desktop does after an
 * unclean shutdown (`rebuildCrashSensitiveIndexes`), and verified:
 *
 *   - every acknowledged row survived (read from the heap, not an index);
 *   - amcheck: heap, every btree (heapallindexed) and every GIN index;
 *   - every HNSW index answers a nearest-neighbour query through the index;
 *   - every BM25 index accepts an insert and answers a ranked search.
 *
 * Coverage limit: NODEFS `fsync` is a no-op, so this proves process crashes
 * (SIGKILL: the OS keeps every completed write), not power loss.
 *
 * CRASH_GATE_ITERATIONS (default 10; nightly 200) and CRASH_GATE_SEED select the
 * run. A failure names the seed, the iteration, the check and the index/table;
 * the seed reproduces the workload and the kill schedule, not the exact kill instant.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { amcheck } from '@electric-sql/pglite/contrib/amcheck';
import { describe, it, onTestFinished } from 'vitest';
import { rebuildCrashSensitiveIndexes } from '../src/crash-sensitive-indexes';
import { migrate } from '../src/migrations/bootstrap';
import { createEnginePglite, ENGINE_EXTENSIONS } from '../src/pglite-factory';
import {
  ACK_PREFIX,
  type CrashAck,
  createRandom,
  iterationSeed,
  MAX_RUN,
  parseAcks,
} from './helpers/crash-injection-protocol';
import {
  CrashGateCheckError,
  verifyAccessMethodsCovered,
  verifyAckedRowsSurvived,
  verifyBm25,
  verifyHnsw,
  verifyStructure,
} from './helpers/crash-injection-verify';
import { createPGliteTestDataDir } from './test-data-dir';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WRITER_PATH = fileURLToPath(new URL('./helpers/crash-injection-writer.ts', import.meta.url));
const MIN_KILL_DELAY_MS = 300;
const MAX_KILL_DELAY_MS = 3000;
// Failure ceilings, ~10x the measured iteration: boot + WAL replay + first commit, and one whole iteration.
const FIRST_ACK_TIMEOUT_MS = 60_000;
const PER_ITERATION_TIMEOUT_MS = 30_000;
const SETUP_TIMEOUT_MS = 120_000;

function readInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}; got ${raw}`);
  }
  return value;
}

const ITERATIONS = readInteger('CRASH_GATE_ITERATIONS', 10, 1, MAX_RUN);
const SEED = readInteger('CRASH_GATE_SEED', Math.floor(Math.random() * 2 ** 31), 0, 2 ** 32 - 1);

/** Spawns the writer, waits for its first ack, lets it run `killAfterMs` more, then SIGKILLs it. */
function runWriterUntilKilled(
  dataDir: string,
  run: number,
  seed: number,
  killAfterMs: number
): Promise<CrashAck[]> {
  return new Promise((resolve, reject) => {
    // One process, no wrapper: the `tsx` CLI would spawn a grandchild a SIGKILL never reaches.
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', WRITER_PATH, dataDir, String(run), String(seed)],
      { cwd: PACKAGE_ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    onTestFinished(() => {
      child.kill('SIGKILL');
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    let killTimer: NodeJS.Timeout | undefined;
    const fail = (detail: string): void =>
      reject(
        new CrashGateCheckError(
          'writer',
          'crash-injection-writer',
          `${detail}; stderr: ${stderr.slice(-2000)}`
        )
      );
    const ackTimer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(`wrote no ack within ${FIRST_ACK_TIMEOUT_MS} ms`);
    }, FIRST_ACK_TIMEOUT_MS);

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      // The kill clock starts once, at the first acknowledged commit.
      if (killTimer || !stdout.includes(ACK_PREFIX)) {
        return;
      }
      clearTimeout(ackTimer);
      killTimer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, killAfterMs);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    // `close`, not `exit`: it fires after stdout drains, so no ack is lost.
    child.on('close', (code, signal) => {
      clearTimeout(ackTimer);
      clearTimeout(killTimer);
      if (killed && signal === 'SIGKILL') {
        resolve(parseAcks(stdout));
        return;
      }
      // The writer only stops on its own when the database under it is broken.
      fail(`ended without being killed (code=${code} signal=${signal})`);
    });
  });
}

/** amcheck cannot join the production engine set, so it gets its own handle: that set plus the one contrib. */
async function checkStructure(dataDir: string): Promise<void> {
  const checker = await PGlite.create({ dataDir, extensions: { ...ENGINE_EXTENSIONS, amcheck } });
  try {
    await verifyStructure(checker);
  } finally {
    await checker.close();
  }
}

describe('SIGKILL crash-injection gate (production factory, real migrated schema)', () => {
  it(
    `recovers and verifies every index access method after ${ITERATIONS} SIGKILLs`,
    async () => {
      const dataDir = createPGliteTestDataDir('crash-injection-gate');
      const store = await createEnginePglite({ dataDir });
      try {
        await migrate(store);
      } finally {
        await store.close();
      }

      console.info(`[crash-gate] seed=${SEED} iterations=${ITERATIONS}`);
      const lastSeqByRun = new Map<number, number>();
      const gateStarted = performance.now();
      for (let iteration = 1; iteration <= ITERATIONS; iteration++) {
        const timings: Record<string, number> = {};
        const stage = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
          const started = performance.now();
          try {
            return await work();
          } finally {
            timings[name] = Math.round(performance.now() - started);
          }
        };
        const random = createRandom(iterationSeed(SEED ^ 0x5b_d1_e9_95, iteration));
        const killAfterMs = Math.floor(
          MIN_KILL_DELAY_MS + random() * (MAX_KILL_DELAY_MS - MIN_KILL_DELAY_MS)
        );
        try {
          const acks = await stage('writer', () =>
            runWriterUntilKilled(dataDir, iteration, iterationSeed(SEED, iteration), killAfterMs)
          );
          const newest = acks.at(-1);
          if (!newest) {
            throw new Error('the writer was killed before any transaction was acknowledged');
          }
          lastSeqByRun.set(iteration, newest.seq);
          const messageIds = [...lastSeqByRun].flatMap(([run, lastSeq]) =>
            Array.from({ length: lastSeq }, (_, i) => `crash-msg-${run}-${i + 1}`)
          );

          // Exactly desktop's first open after an unclean shutdown: the production
          // factory, then the production rebuild.
          const db = await stage('reopen', () => createEnginePglite({ dataDir }));
          try {
            await stage('rebuild', () => rebuildCrashSensitiveIndexes(db));
            await stage('verify', async () => {
              await verifyAccessMethodsCovered(db);
              await verifyAckedRowsSurvived(db, { ...newest, messageIds });
              await verifyBm25(db);
              await verifyHnsw(db);
            });
          } finally {
            await db.close();
          }
          await stage('amcheck', () => checkStructure(dataDir));
          console.info(
            `[crash-gate] iteration ${iteration}/${ITERATIONS} ok: killAfter=${killAfterMs}ms acks=${acks.length} ${JSON.stringify(timings)}`
          );
        } catch (error) {
          throw new Error(
            `crash gate failed at iteration ${iteration}/${ITERATIONS}, seed ${SEED}: ${error instanceof Error ? error.message : String(error)}\n` +
              `reproduce: CRASH_GATE_SEED=${SEED} CRASH_GATE_ITERATIONS=${iteration} pnpm --filter @brainstrike/db test:crash-gate`,
            { cause: error }
          );
        }
      }
      console.info(
        `[crash-gate] passed ${ITERATIONS} iterations in ${Math.round(performance.now() - gateStarted)}ms`
      );
    },
    SETUP_TIMEOUT_MS + ITERATIONS * PER_ITERATION_TIMEOUT_MS
  );
});
