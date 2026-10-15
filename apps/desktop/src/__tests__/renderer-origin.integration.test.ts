// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { electronExecutablePath, electronSessionEnvironment } from './helpers/electron-executable';

interface Realm {
  readonly coi: boolean;
  readonly origin: string;
  readonly sab: string;
}

// BST-1999 recorded file-origin documents lacked COI/SAB; a header-only
// webRequest experiment isolated the document but failed actual worker startup.
// ONNX Runtime starts its WASM threads as workers of the embedding worker, so
// the proof follows a nested worker too.
it('isolates a sandboxed hidden inference host and its workers, never the visible document', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bst1999-origin-'));
  try {
    const bundle = join(directory, 'bundle');
    const profile = join(directory, 'profile');
    await Promise.all([mkdir(bundle), mkdir(profile)]);
    const realm =
      'origin: location.origin, coi: crossOriginIsolated, sab: typeof SharedArrayBuffer';
    await Promise.all([
      writeFile(join(bundle, 'index.html'), '<!doctype html><script src="./page.js"></script>'),
      writeFile(
        join(bundle, 'page.js'),
        `globalThis.receipt = new Promise((resolve, reject) => {
        const worker = new Worker('./worker.js', {type: 'module'});
        worker.onmessage = event => {resolve({document: {${realm}}, ...event.data}); worker.terminate();};
        worker.onerror = event => reject(new Error(event.message));
      });`
      ),
      writeFile(
        join(bundle, 'worker.js'),
        `const nested = await new Promise((resolve, reject) => {
        const worker = new Worker('./nested.js', {type: 'module'});
        worker.onmessage = event => resolve(event.data);
        worker.onerror = event => reject(new Error(event.message));
      });
      postMessage({nested, worker: {${realm}}});`
      ),
      writeFile(join(bundle, 'nested.js'), `postMessage({${realm}});`),
    ]);
    const driver = join(directory, 'driver.cjs');
    await build({
      bundle: true,
      entryPoints: [resolve('src/__tests__/fixtures/renderer-origin-electron.ts')],
      external: ['electron'],
      format: 'cjs',
      outfile: driver,
      platform: 'node',
      tsconfigRaw: '{}',
    });
    const { stdout } = await promisify(execFile)(
      electronExecutablePath(),
      [driver, bundle, profile, `--user-data-dir=${profile}`],
      { env: electronSessionEnvironment(), maxBuffer: 1_000_000, timeout: 30_000 }
    );
    const line = stdout.split('\n').find((value) => value.startsWith('ORIGIN_PROOF '));
    if (!line) {
      throw new Error(`Missing Electron origin proof: ${stdout}`);
    }
    const proof: unknown = JSON.parse(line.slice('ORIGIN_PROOF '.length));
    const isolated: Realm = { coi: true, origin: 'brainstrike-app://bundle', sab: 'function' };
    const ordinary: Realm = { coi: false, origin: 'brainstrike-app://bundle', sab: 'undefined' };
    expect(proof).toMatchObject({
      hidden: {
        preferences: {
          contextIsolation: true,
          experimentalFeatures: false,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
        },
        receipt: { document: isolated, nested: isolated, worker: isolated },
      },
      visible: { receipt: { document: ordinary, nested: ordinary, worker: ordinary } },
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 40_000);
