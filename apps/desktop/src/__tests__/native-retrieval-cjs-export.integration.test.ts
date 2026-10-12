// @vitest-environment node

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { type BuildOptions, build } from 'esbuild';
import { expect, it } from 'vitest';
import { MAIN_PROCESS_BUILD_OPTIONS } from '../../scripts/build-main-config.mjs';

const desktopRoot = path.resolve(import.meta.dirname, '../..');
const execute = promisify(execFile);

it('loads the public native search helpers and actual CJS retrieval caller in Electron', async () => {
  const executable: unknown =
    process.env['NATIVE_RETRIEVAL_TEST_EXEC_PATH'] ?? createRequire(import.meta.url)('electron');
  if (typeof executable !== 'string' || executable.length === 0) {
    throw new Error('An installed Electron executable is required for this runtime check.');
  }
  const outdir = await mkdtemp(path.join(desktopRoot, '.native-retrieval-cjs-probe-'));
  try {
    const publicEntry = path.join(outdir, 'public-core.ts');
    await writeFile(
      publicEntry,
      "export { fuseNativeSearchPools, getNativeSemanticAvailability, NATIVE_SEARCH_CANDIDATE_LIMIT, NATIVE_SEARCH_FINAL_LIMIT } from '@brainstrike/workspace-search/core';\n"
    );
    const result = await build({
      ...(MAIN_PROCESS_BUILD_OPTIONS as BuildOptions),
      entryPoints: {
        'native-assistant-retrieval': 'src/assistant-server/native-assistant-retrieval.ts',
        'public-core': publicEntry,
      },
      logLevel: 'silent',
      metafile: true,
      outdir,
      outExtension: { '.js': '.cjs' },
    });
    const runner = path.join(outdir, 'run.cjs');
    await writeFile(
      runner,
      `const assert = require('node:assert/strict');
const core = require('./public-core.cjs');
const caller = require('./native-assistant-retrieval.cjs');
(async () => {
  assert.ok(process.versions.electron, 'must execute in installed Electron');
  assert.equal(core.NATIVE_SEARCH_CANDIDATE_LIMIT, 100);
  assert.equal(core.NATIVE_SEARCH_FINAL_LIMIT, 10);
  assert.throws(() => core.fuseNativeSearchPools({ bm25: null, grep: null }, {}), /requires the BM25 and grep/);
  assert.deepEqual(await core.getNativeSemanticAvailability({ capability: null, profile: null, rootIds: [] }), { available: false, reason: 'Native vector search is unavailable.' });
  assert.equal(typeof caller.searchNativeAssistantChunks, 'function');
  assert.equal(await caller.resolveNativeAssistantCollection({ status: async () => ({ kind: 'ready', embedding: { indexMode: 'vector-configured' }, authorizedCollectionIds: ['saved'] }) }), 'saved');
  console.log(JSON.stringify({ electron: process.versions.electron, node: process.versions.node, executable: process.execPath, publicCoreLoaded: true, retrievalCallerLoaded: true }));
})().catch(error => { console.error(error); process.exitCode = 1; });
`
    );
    // Execute before inspecting the bundle so the negative control proves the actual runtime failure.
    const runtime = await execute(executable, [runner], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 30_000,
    });
    expect(runtime.stdout).toContain('"publicCoreLoaded":true');
    expect(runtime.stdout).toContain('"retrievalCallerLoaded":true');
    expect(Object.keys(result.metafile?.inputs ?? {})).toContain(
      '../../packages/workspace-search/src/core/native-workspace-search.ts'
    );
    expect(await readFile(path.join(outdir, 'native-assistant-retrieval.cjs'), 'utf8')).not.toMatch(
      /require\(["']@brainstrike\/workspace-search\/core["']\)/u
    );
    console.info(runtime.stdout.trim());
  } finally {
    await rm(outdir, { force: true, recursive: true });
  }
}, 60_000);
