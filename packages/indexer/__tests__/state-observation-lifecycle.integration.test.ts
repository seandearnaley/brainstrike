import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openIndexer } from '@brainstrike/indexer';
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { Schema } from 'effect';
import { afterEach, expect, it, type TestContext } from 'vitest';
import { ObservationLifecycle } from './fixtures/state-observation-lifecycle.js';

const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 };
const owners = new WeakMap<TestContext['task'], ObservationLifecycle>();
function ownerFor(context: TestContext) {
  const owner = new ObservationLifecycle(context);
  owners.set(context.task, owner);
  return owner;
}
const receiptSchema = Schema.Struct({
  aborted: Schema.Boolean,
  childJoined: Schema.Boolean,
  childLiveAtWatchdog: Schema.Boolean,
  cleanupJoined: Schema.Boolean,
  elapsedMs: Schema.Finite,
  queryPublished: Schema.Finite,
  rootRemoved: Schema.Boolean,
  rootRetainedAtWatchdog: Schema.Boolean,
  storePublished: Schema.Finite,
});
const reportSchema = Schema.Struct({
  numFailedTests: Schema.Finite,
  numPassedTests: Schema.Finite,
});
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

const probeReceipt = process.env['BRAINSTRIKE_OBSERVATION_WATCHDOG_RECEIPT'];
if (probeReceipt === undefined) {
  afterEach(async (context) => {
    await owners.get(context.task)?.close();
  }, getAdjustedTimeout('database'));

  it(
    'proves the original watchdog retains then joins a real late owner without publishing Store/query',
    (context) => {
      const owner = ownerFor(context);
      return owner.execute(async () => {
        const directory = await owner.acquire(
          () => mkdtemp(join(tmpdir(), 'observation-watchdog-receipt-')),
          (ownedDirectory) => rm(ownedDirectory, { force: true, recursive: true }),
          { removal: true }
        );
        const receiptPath = join(directory, 'receipt.json');
        const reportPath = join(directory, 'vitest.json');
        let output = '';
        const result = await owner.acquire(
          () => {
            const child = spawn(
              process.execPath,
              [
                join(import.meta.dirname, '..', 'node_modules', 'vitest', 'vitest.mjs'),
                'run',
                '--config',
                'vitest.integration.config.mts',
                '__tests__/state-observation-lifecycle.integration.test.ts',
                '--reporter=json',
                '--outputFile',
                reportPath,
              ],
              {
                cwd: join(import.meta.dirname, '..'),
                env: { ...process.env, BRAINSTRIKE_OBSERVATION_WATCHDOG_RECEIPT: receiptPath },
                stdio: ['ignore', 'pipe', 'pipe'],
              }
            );
            child.stdout.on('data', (bytes: Buffer) => {
              output += bytes.toString();
            });
            child.stderr.on('data', (bytes: Buffer) => {
              output += bytes.toString();
            });
            const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
              (resolve, reject) => {
                child.once('error', reject);
                // close joins both process exit and the captured stdio tails.
                child.once('close', (code, signal) => resolve({ code, signal }));
              }
            );
            return { child, closed };
          },
          async ({ child, closed }) => {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill();
            }
            await closed;
          }
        );
        expect(await result.closed).toEqual({ code: 1, signal: null });
        const reportText = await readFile(reportPath, 'utf8');
        const report: unknown = JSON.parse(reportText);
        expect(Schema.decodeUnknownSync(reportSchema)(report)).toEqual({
          numFailedTests: 1,
          numPassedTests: 0,
        });
        expect(reportText).toContain('Test timed out in 5000ms');
        const receipt: unknown = JSON.parse(await readFile(receiptPath, 'utf8'));
        const decoded = Schema.decodeUnknownSync(receiptSchema)(receipt);
        expect(decoded).toMatchObject({
          aborted: true,
          childJoined: true,
          childLiveAtWatchdog: true,
          cleanupJoined: true,
          queryPublished: 0,
          rootRemoved: true,
          rootRetainedAtWatchdog: true,
          storePublished: 0,
        });
        // Preserve the intentional failure and joined-cleanup receipt in qualification output.
        console.info(
          'original-watchdog ownership proof: Test timed out in 5000ms',
          JSON.stringify(decoded),
          output
        );
      });
    },
    getAdjustedTimeout('database')
  );

  it(
    'preserves primary and cleanup failures, retains Root and performs no automatic cleanup retry',
    async (context) => {
      const owner = ownerFor(context);
      const primary = new Error('original observation callback failure');
      const cleanup = new Error('recorded observation cleanup failure');
      const root = await owner.acquire(
        () => mkdtemp(join(tmpdir(), 'observation-cleanup-retained-')),
        (ownedRoot) => rm(ownedRoot, { force: true, recursive: true }),
        { removal: true }
      );
      let closeAttempts = 0;
      const port = await owner.acquire(
        () =>
          openIndexer(
            {
              dbPath: join(root, 'index.sqlite'),
              embedding: { indexMode: 'text-only' },
              rootIds: ['root'],
            },
            deadlines
          ),
        async (ownedPort) => {
          closeAttempts += 1;
          await ownedPort.close();
          throw cleanup;
        }
      );
      const pid = (await port.info()).pid;
      try {
        await expect(owner.execute(() => Promise.reject(primary))).rejects.toBe(primary);
        const retirement = owner.close();
        await expect(retirement).rejects.toMatchObject({ errors: [primary, cleanup] });
        expect(owner.close()).toBe(retirement);
        expect(closeAttempts).toBe(1);
        expect(existsSync(root)).toBe(true);
        expect(alive(pid)).toBe(false);
      } finally {
        // Explicit control cleanup after proving retention; never an automatic fixture retry.
        await port.destroy();
        await rm(root, { force: true, recursive: true });
        // Expected failure was asserted above; do not have the shared hook replay it.
        owners.delete(context.task);
      }
    },
    getAdjustedTimeout('database')
  );
} else {
  let actualContext: TestContext | undefined;
  let root: string | undefined;
  let pid: number | undefined;
  let port: Awaited<ReturnType<typeof openIndexer>> | undefined;
  let childLiveAtWatchdog = false;
  let rootRetainedAtWatchdog = false;
  let storePublished = 0;
  let queryPublished = 0;
  const started = performance.now();
  afterEach(async (context) => {
    let cleanupJoined = false;
    try {
      await owners.get(context.task)?.close();
      cleanupJoined = true;
    } finally {
      await writeFile(
        probeReceipt,
        JSON.stringify({
          aborted: actualContext?.signal.aborted === true,
          childJoined: pid !== undefined && !alive(pid),
          childLiveAtWatchdog,
          cleanupJoined,
          elapsedMs: performance.now() - started,
          queryPublished,
          rootRemoved: root !== undefined && !existsSync(root),
          rootRetainedAtWatchdog,
          storePublished,
        })
      );
    }
  }, getAdjustedTimeout('database'));
  // Deliberately retain Vitest's original callback watchdog. The only release is teardown.
  it('joins a real indexer acquired across the original 5000ms watchdog', (context) => {
    actualContext = context;
    const owner = ownerFor(context);
    const release = Promise.withResolvers<void>();
    owner.releaseOnRetirement(() => release.resolve());
    context.signal.addEventListener(
      'abort',
      () => {
        rootRetainedAtWatchdog = root !== undefined && existsSync(root);
        childLiveAtWatchdog = pid !== undefined && alive(pid);
      },
      { once: true }
    );
    return owner.execute(async () => {
      const ownedRoot = realpathSync(
        await owner.acquire(
          () => mkdtemp(join(tmpdir(), 'observation-watchdog-owned-')),
          async (ownedRoot) => {
            await port?.destroy();
            await rm(ownedRoot, { force: true, recursive: true });
          },
          { removal: true }
        )
      );
      root = ownedRoot;
      await owner.acquire(
        () =>
          openIndexer(
            {
              dbPath: join(ownedRoot, 'index.sqlite'),
              embedding: { indexMode: 'text-only' },
              rootIds: ['root'],
            },
            deadlines
          ),
        (ownedPort) => ownedPort.close(),
        {
          beforePublication: async (ownedPort) => {
            port = ownedPort;
            pid = (await ownedPort.info()).pid;
            await release.promise;
          },
        }
      );
      // These stand for the fixture continuations; an aborted acquisition must publish neither.
      storePublished += 1;
      owner.check();
      queryPublished += 1;
    });
  }, 5000);
}
