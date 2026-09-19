// Run after `pnpm knip` has built the config dependencies. This deliberately
// mutates two fixture inputs, invokes the real installed auditor, then restores
// the checkout even when detection fails. Never run alongside another Knip scan.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const fixture = 'apps/web/src/knip-liveness-unused-fixture.ts';
const manifest = 'packages/db-explorer/package.json';
const dependency = '@brainstrike/platform-utils';
const fixturePath = path.join(repoRoot, fixture);
const manifestPath = path.join(repoRoot, manifest);
const original = readFileSync(manifestPath, 'utf8');
const pkg = JSON.parse(original);
assert.ok(
  pkg.dependencies && typeof pkg.dependencies === 'object',
  'db-explorer must declare a dependencies object for the liveness probe'
);
assert.ok(!existsSync(fixturePath), 'refusing to overwrite a pre-existing fixture');
assert.ok(!pkg.dependencies[dependency], 'probe dependency must be absent before planting');

writeFileSync(fixturePath, 'export const knipLivenessUnusedFixture = true;\n', { flag: 'wx' });
try {
  pkg.dependencies[dependency] = 'workspace:*';
  writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`);
  const start = performance.now();
  const result = spawnSync(
    process.execPath,
    ['node_modules/knip/bin/knip.js', '--reporter', 'json', '--no-config-hints'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 120_000 }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1, `expected findings exit 1:\n${result.stdout}\n${result.stderr}`);
  // Config loaders may log before the reporter; Knip's JSON reporter emits its
  // one complete document on the final stdout line. Do not accept missing JSON.
  // Observed with installed Knip 6.34.0; changing this protocol requires a real
  // planted-input run, not only the control-flow stubs in the unit tests.
  const report = JSON.parse(result.stdout.trim().split('\n').at(-1));
  const schemaMessage =
    'Unsupported Knip 6 JSON reporter schema; rerun the planted-input audit when upgrading Knip';
  assert.ok(report && Array.isArray(report.issues), schemaMessage);
  const { issues } = report;
  for (const issue of issues) {
    assert.ok(issue && typeof issue.file === 'string', schemaMessage);
    if (issue.file === manifest) {
      assert.ok(Array.isArray(issue.dependencies), schemaMessage);
      assert.ok(
        issue.dependencies.every((item) => item && typeof item.name === 'string'),
        schemaMessage
      );
    } else {
      assert.ok(Array.isArray(issue.files), schemaMessage);
    }
  }
  assert.ok(issues.some((issue) => issue.file === fixture && issue.files.length > 0));
  assert.ok(
    issues.some(
      (issue) =>
        issue.file === manifest && issue.dependencies.some((item) => item.name === dependency)
    )
  );
  for (const entry of [
    'apps/desktop/src/diagnostics/main-watchdog-worker.ts',
    'apps/desktop/src/official-conformance-client-entry.ts',
    'packages/workers/file-content-worker.ts',
    'packages/embeddings/src/cli/embed-code.ts',
    'packages/db/src/cli/queue-cli.ts',
  ]) {
    assert.ok(existsSync(path.join(repoRoot, entry)), `missing protected entry: ${entry}`);
    assert.ok(
      !issues.some((issue) => issue.file === entry && issue.files.length > 0),
      `reachable entry reported unused: ${entry}`
    );
  }
  assert.equal(issues.length, 2, 'probe must report only the planted file and dependency');
  console.log(
    `Knip liveness: unused file + dependency detected (exit 1); special entries retained; ${((performance.now() - start) / 1000).toFixed(2)}s`
  );
} finally {
  writeFileSync(manifestPath, original);
  unlinkSync(fixturePath);
}
