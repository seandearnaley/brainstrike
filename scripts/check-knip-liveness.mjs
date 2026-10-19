// Run after `pnpm knip` has built the config dependencies. This deliberately
// mutates fixture inputs, invokes the real installed auditor, then restores
// the checkout even when detection fails. Never run alongside another Knip scan.
//
// Planted inputs:
//   * an unused file and an unused dependency, which the default run reports;
//   * an export in a production module that only a planted test imports. The
//     production run (`knip:production`'s own flags) reports it; default mode
//     with exports re-included does not, because it credits the test import.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const fixture = 'apps/web/src/knip-liveness-unused-fixture.ts';
const manifest = 'packages/db-explorer/package.json';
const dependency = '@brainstrike/platform-utils';
// Reached only from the Vercel functions in apps/web/api, which are production entries.
const productionModule = 'apps/web/src/server/web-assistant-deployment.ts';
const testOnlyConsumer = 'apps/web/src/server/__tests__/knip-liveness-test-only-export.test.ts';
const testOnlyExport = 'knipLivenessTestOnlyExport';
const protectedEntries = [
  'apps/desktop/src/diagnostics/main-watchdog-worker.ts',
  'apps/desktop/src/official-conformance-client-entry.ts',
  'packages/workers/file-content-worker.ts',
  'packages/embeddings/src/cli/embed-code.ts',
  'packages/db/src/cli/queue-cli.ts',
];

const fixturePath = path.join(repoRoot, fixture);
const manifestPath = path.join(repoRoot, manifest);
const modulePath = path.join(repoRoot, productionModule);
const consumerPath = path.join(repoRoot, testOnlyConsumer);
const original = readFileSync(manifestPath, 'utf8');
const originalModule = readFileSync(modulePath, 'utf8');
const pkg = JSON.parse(original);
assert.ok(
  pkg.dependencies && typeof pkg.dependencies === 'object',
  'db-explorer must declare a dependencies object for the liveness probe'
);
assert.ok(!existsSync(fixturePath), 'refusing to overwrite a pre-existing fixture');
assert.ok(!existsSync(consumerPath), 'refusing to overwrite a pre-existing test consumer');
assert.ok(!pkg.dependencies[dependency], 'probe dependency must be absent before planting');
assert.ok(!originalModule.includes(testOnlyExport), 'probe export must be absent before planting');

// The production run uses exactly the flags of the `knip:production` script.
const { scripts } = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const productionCommand = scripts?.['knip:production']?.split('&&').at(-1).trim().split(/\s+/);
assert.ok(
  productionCommand?.[0] === 'knip' && productionCommand.includes('--production'),
  'package.json knip:production must end in `knip --production ...`'
);
const productionArgs = productionCommand.slice(1);

const schemaMessage =
  'Unsupported Knip 6 JSON reporter schema; rerun the planted-input audit when upgrading Knip';
const names = (issue, type) => (issue[type] ?? []).map((item) => item.name);

function audit(args) {
  const label = args.join(' ') || 'default flags';
  const result = spawnSync(
    process.execPath,
    ['node_modules/knip/bin/knip.js', ...args, '--reporter', 'json', '--no-config-hints'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 180_000 }
  );
  assert.ifError(result.error);
  // Each run includes planted findings, so anything but findings exit 1 is a failure.
  assert.equal(
    result.status,
    1,
    `expected findings exit 1 for ${label}:\n${result.stdout}\n${result.stderr}`
  );
  // Config loaders may log before the reporter; Knip's JSON reporter emits its
  // one complete document on the final stdout line. Do not accept missing JSON.
  // Observed with installed Knip 6.41.0; changing this protocol requires a real
  // planted-input run, not only the control-flow stubs in the unit tests.
  const report = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.ok(report && Array.isArray(report.issues), schemaMessage);
  for (const issue of report.issues) {
    assert.ok(issue && typeof issue.file === 'string', schemaMessage);
    const lists = ['files', 'dependencies', 'exports'].filter((type) => type in issue);
    assert.ok(lists.length > 0, schemaMessage);
    for (const type of lists) {
      assert.ok(Array.isArray(issue[type]), schemaMessage);
      assert.ok(
        issue[type].every((item) => item && typeof item.name === 'string'),
        schemaMessage
      );
    }
  }
  for (const entry of protectedEntries) {
    assert.ok(existsSync(path.join(repoRoot, entry)), `missing protected entry: ${entry}`);
    assert.ok(
      !report.issues.some((issue) => issue.file === entry && names(issue, 'files').length > 0),
      `reachable entry reported unused (${label}): ${entry}`
    );
  }
  assert.ok(
    report.issues.some((issue) => issue.file === fixture && names(issue, 'files').length > 0),
    `planted unused file not reported (${label})`
  );
  return report.issues;
}

const exportReported = (issues) =>
  issues.some(
    (issue) => issue.file === productionModule && names(issue, 'exports').includes(testOnlyExport)
  );

writeFileSync(fixturePath, 'export const knipLivenessUnusedFixture = true;\n', { flag: 'wx' });
try {
  pkg.dependencies[dependency] = 'workspace:*';
  writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(modulePath, `${originalModule}\nexport const ${testOnlyExport} = true;\n`);
  writeFileSync(
    consumerPath,
    [
      `import { ${testOnlyExport} } from '../web-assistant-deployment';`,
      `it('reads the planted export', () => expect(${testOnlyExport}).toBe(true));`,
      '',
    ].join('\n'),
    { flag: 'wx' }
  );
  const start = performance.now();

  const defaultIssues = audit([]);
  assert.ok(
    defaultIssues.some(
      (issue) => issue.file === manifest && names(issue, 'dependencies').includes(dependency)
    ),
    'planted unused dependency not reported'
  );
  assert.equal(defaultIssues.length, 2, 'probe must report only the planted file and dependency');

  assert.ok(
    exportReported(audit(productionArgs)),
    'knip:production did not report an export that only a test uses'
  );
  assert.ok(
    !exportReported(audit(['--include', 'files,exports'])),
    'default mode reported an export a test imports; the test import must count there'
  );
  console.log(
    `Knip liveness: unused file + dependency detected; production mode reports a test-only export that default mode credits; special entries retained; ${((performance.now() - start) / 1000).toFixed(2)}s`
  );
} finally {
  writeFileSync(manifestPath, original);
  writeFileSync(modulePath, originalModule);
  unlinkSync(fixturePath);
  if (existsSync(consumerPath)) {
    unlinkSync(consumerPath);
  }
}
