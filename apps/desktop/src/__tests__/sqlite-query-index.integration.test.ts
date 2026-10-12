// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { MAIN_PROCESS_BUILD_OPTIONS } from '../../scripts/build-main-config.mjs';

const execute = promisify(execFile);
const desktop = path.resolve(import.meta.dirname, '../..');

it('queries the authoritative WAL index using real Electron utilities and joins readers before reset', async () => {
  const explicitExecutable = process.env['SQLITE_QUERY_TEST_EXEC_PATH'];
  const executable: unknown = explicitExecutable ?? createRequire(import.meta.url)('electron');
  if (typeof executable !== 'string') {
    throw new TypeError('Qualified Electron executable is required.');
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-query-index-'));
  const output = await mkdtemp(path.join(desktop, '.query-index-proof-'));
  try {
    await build({
      ...MAIN_PROCESS_BUILD_OPTIONS,
      entryPoints: {
        'indexer-host-entry': 'src/indexer-host-entry.ts',
        'proof-main': 'src/__tests__/fixtures/sqlite-query-index-proof.ts',
        'sqlite-query-host-entry': 'src/sqlite-query-host-entry.ts',
      },
      logLevel: 'silent',
      outdir: output,
    });
    const { stdout, stderr } = await execute(
      executable,
      [path.join(output, 'proof-main.js'), '--no-sandbox'],
      {
        env: {
          ...process.env,
          BRAINSTRIKE_QUERY_PROOF_DIR: directory,
          BRAINSTRIKE_QUERY_PROOF_VECTOR: path.resolve(
            desktop,
            '../../packages/indexer/__tests__/fixtures/fused-minilm-384.json'
          ),
          ELECTRON_RUN_AS_NODE: undefined,
        },
        maxBuffer: 1024 * 1024,
        timeout: 20_000,
      }
    );
    console.log(stdout);
    expect(stdout).toContain('SQLITE_QUERY_INDEX_PROOF_OK');
    expect(stdout).toContain('"electron":"44.4.5"');
    expect(stderr).not.toContain('UnhandledPromiseRejection');
  } finally {
    await rm(output, { force: true, recursive: true });
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);
