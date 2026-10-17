import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parsePnpmLockfile } from '../pnpm-lockfile.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

function assertPatched(lock) {
  const versions = Object.keys(lock.packages)
    .filter((key) => key.startsWith('esbuild@'))
    .map((key) => key.slice('esbuild@'.length));
  assert.ok(versions.length > 0, 'expected esbuild in the graph');
  for (const version of versions) {
    assert.match(version, /^0\.\d+\.\d+$/, `review esbuild@${version}`);
    const [, minor, patch] = version.split('.').map(Number);
    assert.ok(
      minor >= 25 && !(minor === 27 && patch >= 3) && !(minor === 28 && patch < 1),
      `vulnerable esbuild@${version}`
    );
  }
}

test('every esbuild copy clears both development-server advisories', async () => {
  assertPatched(parsePnpmLockfile(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8')));
  for (const version of ['0.18.20', '0.24.2', '0.27.3', '0.27.7', '0.28.0']) {
    assert.throws(() => assertPatched({ packages: { [`esbuild@${version}`]: {} } }), /vulnerable/);
  }
  for (const version of ['0.25.12', '0.27.0', '0.28.1', '0.28.2']) {
    assertPatched({ packages: { [`esbuild@${version}`]: {} } });
  }
  assert.throws(() => assertPatched({ packages: {} }), /expected esbuild/);
});

test('Drizzle omits its unused deprecated loader and retains its TypeScript APIs', async () => {
  const dbRequire = createRequire(path.join(root, 'packages/db/package.json'));
  const kitRequire = createRequire(dbRequire.resolve('drizzle-kit'));
  const lock = parsePnpmLockfile(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8'));
  const snapshot = lock.snapshots['drizzle-kit@0.31.11'];
  assert.ok(
    snapshot?.dependencies,
    'Review the drizzle-kit@0.31.11 overrides and this guard after an owner upgrade'
  );
  assert.equal(snapshot.dependencies['@esbuild-kit/esm-loader'], undefined);
  for (const file of ['bin.cjs', 'api.js', 'api.mjs', 'utils.js', 'utils.mjs']) {
    const source = await readFile(
      path.join(path.dirname(dbRequire.resolve('drizzle-kit')), file),
      'utf8'
    );
    assert.doesNotMatch(source, /@esbuild-kit\/(?:esm-loader|core-utils)/);
  }
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'bst-875-drizzle-'));
  try {
    const schema = path.join(fixture, 'schema.ts');
    const config = path.join(fixture, 'drizzle.config.ts');
    const out = path.join(fixture, 'migrations');
    await writeFile(
      schema,
      `import { pgTable, integer } from ${JSON.stringify(dbRequire.resolve('drizzle-orm/pg-core'))};
      export const proof = pgTable('dependency_proof', { id: integer().primaryKey() });`
    );
    await writeFile(
      config,
      `const dialect: 'postgresql' = 'postgresql';
      export default { dialect, schema: ${JSON.stringify(schema)}, out: ${JSON.stringify(out)} };`
    );
    const result = spawnSync(
      process.execPath,
      [
        path.join(path.dirname(dbRequire.resolve('drizzle-kit')), 'bin.cjs'),
        'generate',
        '--config',
        config,
      ],
      { cwd: fixture, encoding: 'utf8', timeout: 15_000 }
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const files = (await readdir(out)).filter((file) => file.endsWith('.sql'));
    assert.equal(files.length, 1);
    const sql = await readFile(path.join(out, files[0]), 'utf8');
    assert.match(sql, /CREATE TABLE "dependency_proof"/);
    assert.match(sql, /"id" integer PRIMARY KEY NOT NULL/);
    const { require: requireTs } = kitRequire('tsx/cjs/api');
    assert.equal(requireTs(config, import.meta.url).default.dialect, 'postgresql');
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});

for (const owner of ['agent', 'assistant-service']) {
  const ownerRequire = createRequire(path.join(root, 'packages', owner, 'package.json'));
  test(`${owner} tsup preserves TypeScript, ESM/CJS, splitting and source maps`, async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'bst-875-tsup-'));
    try {
      const tsupRequire = createRequire(ownerRequire.resolve('tsup'));
      await writeFile(path.join(fixture, 'package.json'), '{"type":"module"}');
      await writeFile(path.join(fixture, 'dep.ts'), 'export const value: number = 41;');
      const entry = path.join(fixture, 'entry.ts');
      await writeFile(
        entry,
        "export async function answer(): Promise<number> { return (await import('./dep')).value + 1; }"
      );
      const { build } = ownerRequire('tsup');
      await build({
        config: false,
        dts: false,
        entry: [entry],
        format: ['esm', 'cjs'],
        outDir: path.join(fixture, 'out'),
        silent: true,
        sourcemap: true,
        splitting: true,
      });
      const esm = await import(pathToFileURL(path.join(fixture, 'out/entry.js')).href);
      const cjs = createRequire(path.join(fixture, 'package.json'))('./out/entry.cjs');
      assert.equal(await esm.answer(), 42);
      assert.equal(await cjs.answer(), 42);
      const map = JSON.parse(await readFile(path.join(fixture, 'out/entry.js.map'), 'utf8'));
      assert.ok(map.sources.some((source) => source.endsWith('/entry.ts')));
      assertPatched({ packages: { [`esbuild@${tsupRequire('esbuild').version}`]: {} } });
    } finally {
      await rm(fixture, { force: true, recursive: true });
    }
  });
}

for (const owner of ['@vercel/node', '@vercel/backends']) {
  test(`${owner} preserves tsx CommonJS and ESM TypeScript loading`, async () => {
    const rootRequire = createRequire(path.join(root, 'package.json'));
    const vercelRequire = createRequire(rootRequire.resolve('vercel/package.json'));
    const ownerRequire = createRequire(vercelRequire.resolve(owner));
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'bst-875-tsx-'));
    try {
      const cjs = path.join(fixture, 'config.cts');
      const esm = path.join(fixture, 'config.mts');
      await writeFile(cjs, 'export const value: number = 42;');
      await writeFile(esm, 'export const value: number = await Promise.resolve(42);');
      const { require: requireTs } = ownerRequire('tsx/cjs/api');
      const { tsImport } = ownerRequire('tsx/esm/api');
      assert.equal(requireTs(cjs, import.meta.url).value, 42);
      assert.equal((await tsImport(esm, import.meta.url)).value, 42);
      assert.match(ownerRequire('tsx/package.json').version, /^4\.\d+\.\d+$/);
      const tsxRequire = createRequire(ownerRequire.resolve('tsx/cjs/api'));
      assertPatched({ packages: { [`esbuild@${tsxRequire('esbuild').version}`]: {} } });
    } finally {
      await rm(fixture, { force: true, recursive: true });
    }
  });
}
