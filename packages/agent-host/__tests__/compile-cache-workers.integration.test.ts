import { fork } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processStartTime } from '@brainstrike/state-store';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { HOST_STATE_INDEX_DEADLINES } from '../src/host-state-index.js';

const cacheReport = z.object({ directory: z.string().nullable() });
const workerReport = cacheReport.extend({ entry: z.string(), threadId: z.number().int() });
const indexCloseReport = z.object({
  after: z.number().int().nullable(),
  before: z.number().int().nullable(),
  elapsedMs: z.number(),
});
const entries = [
  { name: 'Node host', path: new URL('../dist/host-process-entry.js', import.meta.url) },
  {
    name: 'desktop host initializer',
    path: new URL('./fixtures/desktop-compile-cache-entry.mjs', import.meta.url),
  },
];
/** How the host's own cache is configured; `cache` is where it must live, relative to the probe. */
const variants = [
  { cache: 'own', title: 'enables its own cold cache' },
  { cache: 'launcher', env: 'NODE_COMPILE_CACHE', title: 'inherits a launcher cache' },
  { cache: null, env: 'NODE_DISABLE_COMPILE_CACHE', title: 'runs with caching disabled' },
] as const;

/*
 * BST-2239: the host keeps Node's compile cache for its own thread only. Every Node
 * instance persists what it compiled when it exits, and a worker's exit is joined
 * inside its owner's close. On hosted windows-2025 (run 39336738388) the cold
 * persist took 1640 ms for the state-index worker and 4028 ms for its nested writer,
 * so the index could not close and exit within its 1 s + 1 s windows: the host failed
 * its cleanup, kept its Root and never exited. This reverses the M3 contract that
 * propagated the cache through both index worker levels.
 */
for (const entry of entries) {
  for (const variant of variants) {
    test(`${entry.name} that ${variant.title}: neither index worker level inherits it, and the index closes and exits within its own deadlines without persisting a cache`, async () => {
      // The host's Unix socket lives under TMPDIR too, so keep this disposable
      // system-temp root short enough for its existing portable path limit.
      const temporaryRoot = process.platform === 'darwin' ? '/tmp' : tmpdir();
      const directory = await realpath(await mkdtemp(join(temporaryRoot, 'bs-cache-')));
      await mkdir(join(directory, 'state'));
      const start = processStartTime(process.pid);
      if (!start) {
        throw new Error('The fixture parent must have a physical process identity');
      }
      const launcherCache = join(directory, 'launcher-cache');
      const env: NodeJS.ProcessEnv = {
        BRAINSTRIKE_CACHE_PROBE: directory,
        HOME: directory,
        PATH: process.env['PATH'],
        SystemRoot: process.env['SystemRoot'],
        TEMP: directory,
        TMP: directory,
        TMPDIR: directory,
        ...(variant.cache === 'launcher' ? { NODE_COMPILE_CACHE: launcherCache } : {}),
        ...(variant.cache === null ? { NODE_DISABLE_COMPILE_CACHE: '1' } : {}),
      };
      const child = fork(
        fileURLToPath(entry.path),
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
      try {
        expect(await ready.promise).toEqual({ event: 'ready' });
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
        if (variant.cache === null) {
          expect(parent.directory).toBeNull();
        } else {
          const cache = parent.directory;
          if (!cache) {
            throw new Error('The parent did not enable its cache');
          }
          const location = relative(
            variant.cache === 'launcher' ? launcherCache : directory,
            cache
          );
          expect(isAbsolute(location)).toBe(false);
          expect(location.startsWith('..')).toBe(false);
        }
        expect({ engine: engine?.directory, writer: writer?.directory }).toEqual({
          engine: null,
          writer: null,
        });
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
        await rm(directory, { force: true, recursive: true });
      }
      expect(code, stderr).toBe(0);
      expect(indexClose, 'the platform close recorded the index close').not.toBeNull();
      expect(indexClose?.elapsedMs).toBeLessThan(
        HOST_STATE_INDEX_DEADLINES.closeMs + HOST_STATE_INDEX_DEADLINES.exitMs
      );
      // The index's exits persist no compile cache: the host's own cache is untouched.
      expect(indexClose?.after).toBe(indexClose?.before);
    }, 30_000);
  }
}
