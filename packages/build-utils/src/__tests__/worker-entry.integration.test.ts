import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { expect, it } from 'vitest';
import { preserveWorkerEntryPlugin } from '../worker-entry.js';

it.each([false, true])(
  'initializes a tagged worker once when loading a lazy CJS dependency (entry preserved: %s)',
  async (preserve) => {
    const root = await mkdtemp(join(tmpdir(), 'brainstrike-worker-entry-'));
    try {
      const fixtures = {
        'base.cjs': 'module.exports = { value: 3 };',
        'index.html': '<script type="module" src="/main.js"></script>',
        'lazy.cjs': 'module.exports = { value: 7 };',
        'main.js': 'new Worker(new URL("./worker.js",import.meta.url),{type:"module"})',
        'package.json': '{"type":"module"}',
        'worker.js': `import base from './base.cjs';
        if(globalThis.workerBoot) throw new Error('double bootstrap');
        globalThis.workerBoot=base.value;
        globalThis.loadWorkerDependency=async()=> (await import('./lazy.cjs')).default.value;`,
      };
      await Promise.all(
        Object.entries(fixtures).map(([name, content]) => writeFile(join(root, name), content))
      );
      await build({
        build: { minify: false },
        configFile: false,
        logLevel: 'silent',
        root,
        worker: { format: 'es', plugins: () => (preserve ? [preserveWorkerEntryPlugin()] : []) },
      });
      const assets = join(root, 'dist/assets');
      const worker = (await readdir(assets)).find((name) => name.startsWith('worker-'));
      if (!worker) {
        throw new Error('Build emitted no worker entry');
      }
      const url = `${pathToFileURL(join(assets, worker)).href}#managed-id=one`;
      const run = () =>
        execFileSync(
          process.execPath,
          [
            '--input-type=module',
            '--eval',
            `await import(${JSON.stringify(url)}); console.log(await globalThis.loadWorkerDependency());`,
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 2000 }
        );
      // A changed negative control means investigate upstream chunking; do not
      // restore double startup merely to preserve this canary.
      if (!preserve) {
        expect(run).toThrow('double bootstrap');
        return;
      }
      expect(run()).toBe('7\n');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
);
