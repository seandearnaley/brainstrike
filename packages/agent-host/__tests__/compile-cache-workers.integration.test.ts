import { fork } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processStartTime } from '@brainstrike/state-store';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { HOST_STATE_INDEX_DEADLINES } from '../src/host-state-index.js';

const cacheReport = z.object({ directory: z.string().nullable() });
const workerReport = cacheReport.extend({ entry: z.string(), threadId: z.number().int() });
const indexCloseReport = z.object({ elapsedMs: z.number() });

/** Files Node's compile cache wrote under its default directory, in the probe's temp dir. */
function persistedCacheFiles(temporaryDirectory: string): number {
  const cache = join(temporaryDirectory, 'node-compile-cache');
  return existsSync(cache)
    ? readdirSync(cache, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
        .length
    : 0;
}

/*
 * BST-2239: the agent host runs without Node's compile cache, on its own thread and in
 * the state index's worker and nested writer. Every Node instance persists what it
 * compiled when it exits. On hosted windows-2025 the cold persist took 1640 ms for the
 * index worker and 4028 ms for its writer (run 39336738388), inside the index's 1 s close
 * and 1 s exit windows, so the host failed its cleanup, kept its Root and never exited;
 * the host thread's own took 3537 ms of Main's 5 s lease close (run 39340569328), for
 * about 95 ms saved per warm start. This reverses the M3 contract that enabled the cache
 * in the host and propagated it through both index worker levels.
 */
for (const disabled of [false, true]) {
  test(`the Node host ${disabled ? 'with caching disabled by its launcher' : 'as launched'} enables no compile cache on any thread, closes and exits its index within the index deadlines, and persists no cache`, async () => {
    // The host's Unix socket lives under TMPDIR too, so keep this disposable
    // system-temp root short enough for its existing portable path limit.
    const temporaryRoot = process.platform === 'darwin' ? '/tmp' : tmpdir();
    const directory = await realpath(await mkdtemp(join(temporaryRoot, 'bs-cache-')));
    await mkdir(join(directory, 'state'));
    const start = processStartTime(process.pid);
    if (!start) {
      throw new Error('The fixture parent must have a physical process identity');
    }
    const env: NodeJS.ProcessEnv = {
      BRAINSTRIKE_CACHE_PROBE: directory,
      HOME: directory,
      PATH: process.env['PATH'],
      SystemRoot: process.env['SystemRoot'],
      TEMP: directory,
      TMP: directory,
      TMPDIR: directory,
      ...(disabled ? { NODE_DISABLE_COMPILE_CACHE: '1' } : {}),
    };
    const child = fork(
      fileURLToPath(new URL('../dist/host-process-entry.js', import.meta.url)),
      [
        JSON.stringify({
          lifetime: 'app',
          parent: { pid: process.pid, start },
          root: join(directory, 'state'),
        }),
        fileURLToPath(new URL('./fixtures/compile-cache-platform.mjs', import.meta.url)),
      ],
      {
        env,
        execArgv: [
          '--import',
          new URL('./fixtures/compile-cache-observer.mjs', import.meta.url).href,
        ],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      }
    );
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const ready = Promise.withResolvers<unknown>();
    child.once('message', ready.resolve);
    child.once('error', ready.reject);
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => {
        ready.reject(new Error(`Cache probe closed (${code}): ${stderr}`));
        resolve(code);
      });
    });
    let code: number | null;
    let indexClose: z.infer<typeof indexCloseReport> | null;
    let persisted: number;
    try {
      expect(await ready.promise).toMatchObject({ event: 'ready', record: { pid: child.pid } });
      const parent = cacheReport.parse(
        JSON.parse(await readFile(join(directory, 'parent.json'), 'utf8'))
      );
      const workers = await Promise.all(
        (await readdir(directory))
          .filter((file) => file.startsWith('worker-'))
          .map(async (file) =>
            workerReport.parse(JSON.parse(await readFile(join(directory, file), 'utf8')))
          )
      );
      const engine = workers.find(
        (worker) => basename(worker.entry) === 'host-state-index-worker.js'
      );
      const writer = workers.find((worker) => basename(worker.entry) === 'writer-worker.js');
      expect(engine).toBeDefined();
      expect(writer).toBeDefined();
      expect(engine?.threadId).not.toBe(writer?.threadId);
      expect({
        engine: engine?.directory,
        host: parent.directory,
        writer: writer?.directory,
      }).toEqual({ engine: null, host: null, writer: null });
    } finally {
      if (child.connected) {
        child.disconnect();
      }
      code = await exited;
      // Read before the probe directory goes; a missing report is asserted below.
      indexClose = await readFile(join(directory, 'index-close.json'), 'utf8').then(
        (text) => indexCloseReport.parse(JSON.parse(text)),
        () => null
      );
      persisted = persistedCacheFiles(directory);
      await rm(directory, { force: true, recursive: true });
    }
    expect(code, stderr).toBe(0);
    expect(indexClose, 'the platform close recorded the index close').not.toBeNull();
    expect(indexClose?.elapsedMs).toBeLessThan(
      HOST_STATE_INDEX_DEADLINES.closeMs + HOST_STATE_INDEX_DEADLINES.exitMs
    );
    // Neither the index's exits nor the host's own wrote a compile cache.
    expect(persisted).toBe(0);
  }, 30_000);
}
