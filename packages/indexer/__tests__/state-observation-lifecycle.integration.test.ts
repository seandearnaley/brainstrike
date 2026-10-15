import { fork, spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openIndexer } from '@brainstrike/indexer';
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { Schema } from 'effect';
import { afterEach, expect, it, type TestContext } from 'vitest';
import { createIndexerConnection, IndexerLifecycleError } from '../dist/transport.js';
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
  it(
    'retains a live failed manual close without teardown starting another physical attempt',
    async (context) => {
      const owner = ownerFor(context);
      const root = await owner.acquire(
        () => mkdtemp(join(tmpdir(), 'observation-live-close-retained-')),
        (ownedRoot) => rm(ownedRoot, { force: true, recursive: true }),
        { removal: true }
      );
      const entry = join(root, 'non-exiting-indexer.mjs');
      // Actual native indexer/IPC/writer; only its process-disconnect acknowledgement is refused.
      await writeFile(
        entry,
        `process.disconnect = () => {};\nawait import(${JSON.stringify(new URL('../dist/process-entry.js', import.meta.url).href)});\n`
      );
      let output = '';
      const host = await owner.acquire(
        () => {
          const child = fork(entry, [], {
            execArgv: [],
            serialization: 'advanced',
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          });
          child.stdout?.on('data', (bytes: Buffer) => {
            output += bytes.toString();
          });
          child.stderr?.on('data', (bytes: Buffer) => {
            output += bytes.toString();
          });
          const closed = new Promise<void>((resolve, reject) => {
            child.once('error', reject);
            child.once('close', () => resolve());
          });
          return { child, closed };
        },
        async ({ child, closed }) => {
          if (child.exitCode === null && child.signalCode === null) {
            throw new Error('Live manual-close child is retained until explicit physical cleanup');
          }
          await closed;
        }
      );
      let killAttempts = 0;
      let closeAttempts = 0;
      let permitted = false;
      const connection = createIndexerConnection(
        {
          dbPath: join(root, 'index.sqlite'),
          embedding: { indexMode: 'text-only' },
          rootIds: ['root'],
        },
        // Disconnect and the first kill are refused, so neither exit join can succeed;
        // a short exit deadline reaches the same retained failure without 2 x 5 s waits.
        { ...deadlines, exitMs: 500 },
        {
          kill: () => {
            killAttempts += 1;
            return permitted && host.child.kill();
          },
          onError: (listener) => {
            host.child.on('error', listener);
            return () => host.child.off('error', listener);
          },
          onExit: (listener) => {
            host.child.on('exit', listener);
            return () => host.child.off('exit', listener);
          },
          onMessage: (listener) => {
            host.child.on('message', listener);
            return () => host.child.off('message', listener);
          },
          send: (message) => host.child.send(message),
        }
      );
      const closePhysical = (port: Awaited<ReturnType<typeof openIndexer>>) => {
        closeAttempts += 1;
        return port.close();
      };
      try {
        const port = await owner.acquire(() => connection.ready, closePhysical);
        const pid = (await port.info()).pid;
        const primary = await owner
          .execute(async () => {
            await owner.closeResource(port);
          })
          .catch((error: unknown) => error);
        expect(primary).toBeInstanceOf(IndexerLifecycleError);
        expect(connection.exited).toBe(false);
        expect(alive(pid)).toBe(true);
        expect(closeAttempts).toBe(1);
        expect(killAttempts).toBe(1);
        // A forbidden automatic retry would now physically kill the still-owned process.
        permitted = true;
        const failed = await owner.close().catch((error: unknown) => error);
        expect(failed).toBeInstanceOf(AggregateError);
        if (!(failed instanceof AggregateError)) {
          throw new Error('Failed physical join was discarded');
        }
        expect(failed.errors[0]).toBe(primary);
        console.info(
          'live manual-close ownership receipt',
          JSON.stringify({
            childLive: alive(pid),
            closeAttempts,
            killAttempts,
            rootRetained: existsSync(root),
          }),
          output
        );
        expect(closeAttempts).toBe(1);
        expect(killAttempts).toBe(1);
        expect(connection.exited).toBe(false);
        expect(alive(pid)).toBe(true);
        expect(existsSync(root)).toBe(true);
        const retirement = owner.close();
        expect(owner.close()).toBe(retirement);
        await expect(retirement).rejects.toBe(failed);
      } finally {
        // Explicit control cleanup occurs only after checking the retained failed outcome.
        if (host.child.exitCode === null && host.child.signalCode === null) {
          host.child.kill();
        }
        await host.closed;
        await connection.destroy();
        await rm(root, { force: true, recursive: true });
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
