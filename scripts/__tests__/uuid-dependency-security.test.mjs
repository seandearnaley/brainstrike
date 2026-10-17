import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parsePnpmLockfile } from '../pnpm-lockfile.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const namespace = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

function assertPatched(lock) {
  const versions = Object.keys(lock.packages)
    .filter((key) => key.startsWith('uuid@'))
    .map((key) => key.slice('uuid@'.length));
  assert.ok(versions.length > 0, 'expected uuid in the graph');
  for (const version of versions) {
    assert.match(version, /^(11|12|13|14)\.\d+\.\d+$/, `review uuid@${version}`);
    const [major, minor, patch] = version.split('.').map(Number);
    assert.ok(
      major === 14 ||
        (major === 11 ? minor > 1 || (minor === 1 && patch >= 1) : minor > 0 || patch >= 1),
      `vulnerable uuid@${version}`
    );
  }
}

test('every UUID copy clears the buffer-bounds advisory, with negative controls', async () => {
  assertPatched(parsePnpmLockfile(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8')));
  for (const version of ['10.0.0', '11.1.0', '12.0.0', '13.0.0']) {
    assert.throws(() => assertPatched({ packages: { [`uuid@${version}`]: {} } }));
  }
  assertPatched({
    packages: {
      'uuid@11.1.1': {},
      'uuid@12.0.1': {},
      'uuid@13.0.1': {},
      'uuid@14.0.0': {},
      'uuid@14.0.1': {},
    },
  });
  assert.throws(() => assertPatched({ packages: {} }), /expected uuid/);
});

for (const app of ['web', 'desktop']) {
  const appRequire = createRequire(path.join(root, 'apps', app, 'package.json'));
  test(`${app} plugin UUID v5 rejects partial writes and preserves valid IDs`, () => {
    const pluginRequire = createRequire(appRequire.resolve('vite-plugin-top-level-await'));
    const { v5, parse: parseUuid } = pluginRequire('uuid');
    const expected = '2ed6657d-e927-568b-95e1-2665a8aea6a2';
    assert.equal(v5('www.example.com', namespace), expected);
    for (const [size, offset] of [
      [8, 4],
      [16, 1],
      [16, -1],
    ]) {
      const buffer = new Uint8Array(size).fill(170);
      assert.throws(() => v5('www.example.com', namespace, buffer, offset), RangeError);
      assert.deepEqual(buffer, new Uint8Array(size).fill(170));
    }
    const buffer = new Uint8Array(32).fill(170);
    assert.equal(v5('www.example.com', namespace, buffer, 8), buffer);
    assert.deepEqual(buffer.slice(8, 24), parseUuid(expected));
    assert.deepEqual(buffer.slice(0, 8), new Uint8Array(8).fill(170));
    assert.deepEqual(buffer.slice(24), new Uint8Array(8).fill(170));
  });

  test(`${app} real Vite plugin builds and executes a two-chunk top-level await`, async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'bst-888-tla-'));
    try {
      await writeFile(path.join(fixture, 'package.json'), '{"type":"module"}');
      await writeFile(
        path.join(fixture, 'dep.ts'),
        'export const value: number = await Promise.resolve(41);'
      );
      await writeFile(
        path.join(fixture, 'entry.ts'),
        "import { value } from './dep'; export const answer = value + 1;"
      );
      const { build } = await import(pathToFileURL(appRequire.resolve('vite')).href);
      const topLevelAwait = appRequire('vite-plugin-top-level-await').default;
      const built = await build({
        build: {
          minify: false,
          outDir: 'out',
          rolldownOptions: {
            input: path.join(fixture, 'entry.ts'),
            output: {
              chunkFileNames: '[name].js',
              entryFileNames: 'entry.js',
              manualChunks: (id) => (id.endsWith('/dep.ts') ? 'dep' : undefined),
            },
            preserveEntrySignatures: 'strict',
          },
          target: 'es2020',
        },
        configFile: false,
        logLevel: 'silent',
        plugins: [topLevelAwait()],
        root: fixture,
      });
      assert.equal(built.output.filter((output) => output.type === 'chunk').length, 2);
      const entry = await import(pathToFileURL(path.join(fixture, 'out/entry.js')).href);
      assert.ok(entry.__tla instanceof Promise);
      await entry.__tla;
      assert.equal(entry.answer, 42);
    } finally {
      await rm(fixture, { force: true, recursive: true });
    }
  });
}
