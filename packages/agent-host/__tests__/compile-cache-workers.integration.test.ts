import { fork } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processStartTime } from '@brainstrike/state-store';
import { expect, test } from 'vitest';
import { z } from 'zod';

const cacheReport = z.object({ directory: z.string().nullable() });
const workerReport = cacheReport.extend({ entry: z.string(), threadId: z.number().int() });
const entries = [
  { name: 'Node host', path: new URL('../dist/host-process-entry.js', import.meta.url) },
  {
    name: 'desktop host initializer',
    path: new URL('./fixtures/desktop-compile-cache-entry.mjs', import.meta.url),
  },
];

for (const entry of entries) {
  for (const disabled of [false, true]) {
    test(`${entry.name} ${disabled ? 'preserves disabled caching' : 'propagates its enabled cache'} through both real index worker levels`, async () => {
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
      const closed = new Promise<number | null>((resolve) => {
        child.once('exit', (code) => {
          ready.reject(new Error(`Cache probe closed (${code}): ${stderr}`));
          resolve(code);
        });
      });
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
        if (disabled) {
          expect(parent.directory).toBeNull();
        } else {
          expect(parent.directory).not.toBeNull();
          const cache = parent.directory;
          if (!cache) {
            throw new Error('The parent did not enable its cache');
          }
          const location = relative(directory, cache);
          expect(isAbsolute(location)).toBe(false);
          expect(location.startsWith('..')).toBe(false);
        }
        expect({ engine: engine?.directory, writer: writer?.directory }).toEqual({
          engine: parent.directory,
          writer: parent.directory,
        });
      } finally {
        if (child.connected) {
          child.disconnect();
        }
        const code = await closed;
        await rm(directory, { force: true, recursive: true });
        expect(code, stderr).toBe(0);
      }
    }, 30_000);
  }
}
