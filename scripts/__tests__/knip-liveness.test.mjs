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
const productionModule = 'apps/web/src/server/web-assistant-deployment.ts';
const testOnlyConsumer = 'apps/web/src/server/__tests__/knip-liveness-test-only-export.test.ts';
const testOnlyExport = 'knipLivenessTestOnlyExport';
const productionScript =
  'node scripts/run-turbo-command.mjs -- run build && knip --production --include files,exports';
const entries = [
  'apps/desktop/src/diagnostics/main-watchdog-worker.ts',
  'apps/desktop/src/official-conformance-client-entry.ts',
  'packages/workers/file-content-worker.ts',
  'packages/embeddings/src/cli/embed-code.ts',
  'packages/db/src/cli/queue-cli.ts',
];
const plantedFile = { file: fixture, files: [{ name: fixture }] };
const plantedDependency = {
  dependencies: [{ name: '@brainstrike/platform-utils' }],
  file: manifest,
};
const plantedExport = { exports: [{ name: testOnlyExport }], file: productionModule };
const defaultRun = { issues: [plantedFile, plantedDependency], status: 1 };
const productionRun = { issues: [plantedFile, plantedExport], status: 1 };
// Default mode with exports re-included: the test import credits the export.
const creditedRun = { issues: [plantedFile], status: 1 };

for (const [name, runs, failure] of [
  ['every planted finding', { creditedRun, defaultRun, productionRun }, null],
  [
    'silent no-op auditor',
    { creditedRun, defaultRun: { issues: [], status: 0 }, productionRun },
    /expected findings exit 1/,
  ],
  [
    'missing dependency finding',
    { creditedRun, defaultRun: { issues: [plantedFile], status: 1 }, productionRun },
    /planted unused dependency not reported/,
  ],
  [
    'tool failure',
    { creditedRun, defaultRun: { issues: [], status: 2 }, productionRun },
    /expected findings exit 1/,
  ],
  [
    'reporter schema drift',
    { creditedRun, defaultRun: { issues: [{ file: fixture }], status: 1 }, productionRun },
    /Unsupported Knip 6 JSON reporter schema/,
  ],
  [
    'lost special entry',
    {
      creditedRun,
      defaultRun: {
        ...defaultRun,
        issues: [...defaultRun.issues, { file: entries[0], files: [{ name: entries[0] }] }],
      },
      productionRun,
    },
    /reachable entry reported unused/,
  ],
  [
    'production mode missing the test-only export',
    { creditedRun, defaultRun, productionRun: { issues: [plantedFile], status: 1 } },
    /knip:production did not report an export that only a test uses/,
  ],
  [
    'silent production auditor',
    { creditedRun, defaultRun, productionRun: { issues: [], status: 0 } },
    /expected findings exit 1 for --production/,
  ],
  [
    'production tool failure',
    { creditedRun, defaultRun, productionRun: { issues: [], status: 2 } },
    /expected findings exit 1 for --production/,
  ],
  [
    'production entry reported unused',
    {
      creditedRun,
      defaultRun,
      productionRun: {
        ...productionRun,
        issues: [...productionRun.issues, { file: entries[1], files: [{ name: entries[1] }] }],
      },
    },
    /reachable entry reported unused \(--production/,
  ],
  [
    'default mode not crediting the test import',
    { creditedRun: { issues: [plantedFile, plantedExport], status: 1 }, defaultRun, productionRun },
    /default mode reported an export a test imports/,
  ],
  [
    'silent credited run',
    { creditedRun: { issues: [], status: 0 }, defaultRun, productionRun },
    /expected findings exit 1 for --include/,
  ],
]) {
  test(`liveness ${name}: validates verdict and restores inputs`, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'knip-liveness-'));
    const original = '{"dependencies":{}}\n';
    const moduleSource = 'export const productionExport = true;\n';
    try {
      for (const file of [
        'scripts/check-knip-liveness.mjs',
        fixture,
        manifest,
        productionModule,
        testOnlyConsumer,
        ...entries,
        'node_modules/knip/bin/knip.js',
      ]) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      }
      cpSync(source, path.join(root, 'scripts/check-knip-liveness.mjs'));
      writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({ scripts: { 'knip:production': productionScript } })
      );
      writeFileSync(path.join(root, manifest), original);
      writeFileSync(path.join(root, productionModule), moduleSource);
      for (const entry of entries) {
        writeFileSync(path.join(root, entry), '');
      }
      // The stand-in auditor answers by mode, and checks that every input was
      // planted for that run: the production run must get the script's flags.
      writeFileSync(
        path.join(root, 'node_modules/knip/bin/knip.js'),
        `
        const fs = require('node:fs');
        const args = process.argv.slice(2);
        if (!fs.existsSync('${fixture}')) throw new Error('fixture not planted');
        if (!JSON.parse(fs.readFileSync('${manifest}')).dependencies['@brainstrike/platform-utils']) throw new Error('dependency not planted');
        if (!fs.readFileSync('${productionModule}', 'utf8').includes('export const ${testOnlyExport}')) throw new Error('export not planted');
        if (!fs.readFileSync('${testOnlyConsumer}', 'utf8').includes('${testOnlyExport}')) throw new Error('test consumer not planted');
        const runs = ${JSON.stringify(runs)};
        const mode = args.includes('--production')
          ? 'productionRun'
          : args.includes('--include') ? 'creditedRun' : 'defaultRun';
        if (mode === 'productionRun' && args.join(' ') !== '--production --include files,exports --reporter json --no-config-hints') {
          throw new Error('production run lost the knip:production flags: ' + args.join(' '));
        }
        console.log('config loader output');
        console.log(JSON.stringify({ issues: runs[mode].issues }));
        process.exit(runs[mode].status);
      `
      );
      const result = spawnSync(process.execPath, ['scripts/check-knip-liveness.mjs'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, failure ? 1 : 0, result.stdout + result.stderr);
      if (failure) {
        assert.match(result.stderr, failure);
      }
      assert.equal(readFileSync(path.join(root, manifest), 'utf8'), original);
      assert.equal(readFileSync(path.join(root, productionModule), 'utf8'), moduleSource);
      assert.equal(existsSync(path.join(root, fixture)), false);
      assert.equal(existsSync(path.join(root, testOnlyConsumer)), false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
}
