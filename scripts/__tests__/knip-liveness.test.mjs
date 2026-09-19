import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const source = new URL('../check-knip-liveness.mjs', import.meta.url);
const fixture = 'apps/web/src/knip-liveness-unused-fixture.ts';
const manifest = 'packages/db-explorer/package.json';
const entries = [
  'apps/desktop/src/diagnostics/main-watchdog-worker.ts',
  'apps/desktop/src/official-conformance-client-entry.ts',
  'packages/workers/file-content-worker.ts',
  'packages/embeddings/src/cli/embed-code.ts',
  'packages/db/src/cli/queue-cli.ts',
];
const findings = [
  { file: fixture, files: [{ name: fixture }] },
  { dependencies: [{ name: '@brainstrike/platform-utils' }], file: manifest },
];

for (const [name, status, issues, passes] of [
  ['both planted findings', 1, findings, true],
  ['silent no-op auditor', 0, [], false],
  ['missing dependency finding', 1, findings.slice(0, 1), false],
  ['tool failure', 2, [], false],
  ['lost special entry', 1, [...findings, { file: entries[0], files: [{}] }], false],
]) {
  test(`liveness ${name}: validates verdict and restores inputs`, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'knip-liveness-'));
    const original = '{"dependencies":{}}\n';
    try {
      for (const file of [
        'scripts/check-knip-liveness.mjs',
        fixture,
        manifest,
        ...entries,
        'node_modules/knip/bin/knip.js',
      ]) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      }
      cpSync(source, path.join(root, 'scripts/check-knip-liveness.mjs'));
      writeFileSync(path.join(root, manifest), original);
      for (const entry of entries) {
        writeFileSync(path.join(root, entry), '');
      }
      writeFileSync(
        path.join(root, 'node_modules/knip/bin/knip.js'),
        `
        const fs = require('node:fs');
        if (!fs.existsSync('${fixture}')) throw new Error('fixture not planted');
        if (!JSON.parse(fs.readFileSync('${manifest}')).dependencies['@brainstrike/platform-utils']) throw new Error('dependency not planted');
        console.log('config loader output');
        console.log(${JSON.stringify(JSON.stringify({ issues }))});
        process.exit(${status});
      `
      );
      const result = spawnSync(process.execPath, ['scripts/check-knip-liveness.mjs'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
      });
      assert.ifError(result.error);
      assert.equal(result.status === 0, passes, result.stdout + result.stderr);
      assert.equal(readFileSync(path.join(root, manifest), 'utf8'), original);
      assert.equal(existsSync(path.join(root, fixture)), false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
}
