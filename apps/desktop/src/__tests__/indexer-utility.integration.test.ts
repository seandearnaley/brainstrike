// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { MAIN_PROCESS_BUILD_OPTIONS } from '../../scripts/build-main-config.mjs';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const desktop = path.resolve(import.meta.dirname, '../..');
const electron: unknown = require('electron');
if (typeof electron !== 'string') {
  throw new TypeError('Electron executable is required.');
}
const executable = electron;

describe('actual Electron indexer utility process', () => {
  for (const mode of ['positive', 'startup', 'request', 'close']) {
    it(`qualifies ${mode} ownership with no child-process substitution`, async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-indexer-utility-'));
      const fixtureDirectory = await mkdtemp(path.join(desktop, '.indexer-proof-'));
      try {
        await build({
          ...MAIN_PROCESS_BUILD_OPTIONS,
          entryPoints: {
            'indexer-host-entry': 'src/indexer-host-entry.ts',
            'proof-main': 'src/__tests__/fixtures/indexer-utility-proof.ts',
          },
          logLevel: 'silent',
          outdir: fixtureDirectory,
        });
        const entryPath = path.join(
          fixtureDirectory,
          mode === 'positive' ? 'indexer-host-entry.js' : 'negative.cjs'
        );
        if (mode !== 'positive') {
          const body =
            mode === 'startup'
              ? "process.parentPort.on('message', () => {});"
              : `process.parentPort.once('message', event => { void import('@brainstrike/indexer/host').then(({runIndexerProcess}) => runIndexerProcess(event.data, { send: value => process.parentPort.postMessage(value), onMessage: listener => process.parentPort.on('message', next => { if(next.data.op !== '${mode === 'request' ? 'search' : 'close'}') listener(next.data); }), finish: () => setImmediate(() => process.exit()) })); });`;
          await writeFile(entryPath, body);
        }
        const { stdout, stderr } = await execute(
          executable,
          [path.join(fixtureDirectory, 'proof-main.js'), '--no-sandbox'],
          {
            env: {
              ...process.env,
              BRAINSTRIKE_INDEXER_PROOF_DIR: directory,
              BRAINSTRIKE_INDEXER_PROOF_ENTRY: entryPath,
              BRAINSTRIKE_INDEXER_PROOF_MODE: mode,
              ELECTRON_RUN_AS_NODE: undefined,
            },
            maxBuffer: 1024 * 1024,
            timeout: mode === 'startup' ? 1500 : 20_000,
          }
        );
        console.log(stdout);
        expect(stdout).toContain(`INDEXER_UTILITY_PROOF_OK:${mode}`);
        if (mode === 'positive') {
          expect(stdout).toContain('"electron":"44.4.5"');
        }
        expect(stderr).not.toContain('UnhandledPromiseRejection');
      } finally {
        await rm(fixtureDirectory, { force: true, recursive: true });
        await rm(directory, { force: true, recursive: true });
      }
    }, 30_000);
  }
});
