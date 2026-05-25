import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildCiPlan,
  collectCiPlan,
  parsePlanArgs,
  renderGithubOutputs,
} from '../ci-plan.mjs';

const SHA_1 = '1111111111111111111111111111111111111111';
const SHA_2 = '2222222222222222222222222222222222222222';
const SHA_3 = '3333333333333333333333333333333333333333';

function planFor(files) {
  return buildCiPlan({
    base: 'origin/main',
    baseSha: SHA_1,
    eventName: 'pull_request',
    files,
    head: 'HEAD',
    headSha: SHA_2,
    mergeBase: SHA_3,
  });
}

test('docs-only changes select only the static docs job', () => {
  const plan = planFor(['docs/architecture-reset/ci-computed-risk-plan-onboarding.html']);

  assert.equal(plan.risk.category, 'docs-only');
  assert.deepEqual(plan.lanes, ['docs-static']);
  assert.deepEqual(plan.requiredJobs, ['plan', 'docs-static']);
  assert.equal(plan.jobs.docs_static, true);
  assert.equal(plan.jobs.checks, false);
  assert.equal(plan.jobs.unit_affected, false);
  assert.equal(plan.jobs.web_e2e_pr, false);
  assert.equal(plan.jobs.desktop_e2e_pr, false);
  assert.deepEqual(plan.webE2eMatrix, { include: [] });
  assert.deepEqual(plan.desktopE2eMatrix, { include: [] });
});

test('tooling changes select checks and affected unit tests without e2e', () => {
  const plan = planFor(['scripts/ci-risk-rules.mjs']);

  assert.equal(plan.risk.category, 'config-tooling');
  assert.deepEqual(plan.lanes, ['unit']);
  assert.deepEqual(plan.requiredJobs, ['plan', 'checks', 'unit_affected']);
  assert.equal(plan.jobs.checks, true);
  assert.equal(plan.jobs.unit_affected, true);
  assert.equal(plan.jobs.web_e2e_pr, false);
  assert.equal(plan.jobs.desktop_e2e_pr, false);
  assert.equal(plan.unitMode, 'affected-packages');
});

test('isolated unit test changes keep changed-file unit mode', () => {
  const plan = planFor(['packages/utils/src/__tests__/token-counting-boundary.test.ts']);

  assert.equal(plan.risk.category, 'isolated-unit-test-only');
  assert.equal(plan.jobs.unit_affected, true);
  assert.equal(plan.unitMode, 'changed-unit-tests');
  assert.deepEqual(plan.webE2eMatrix, { include: [] });
  assert.deepEqual(plan.desktopE2eMatrix, { include: [] });
});

test('file explorer changes select only the file explorer web lane', () => {
  const plan = planFor(['packages/file-explorer-ui/src/tree/optimized-file-tree.tsx']);

  assert.equal(plan.risk.category, 'web-ui-file-explorer');
  assert.deepEqual(plan.lanes, ['web-file-explorer-persistence', 'unit']);
  assert.equal(plan.jobs.prepare_web, true);
  assert.equal(plan.jobs.web_e2e_pr, true);
  assert.equal(plan.jobs.prepare_desktop, false);
  assert.equal(plan.jobs.desktop_e2e_pr, false);
  assert.deepEqual(
    plan.webE2eMatrix.include.map((entry) => entry.lane),
    ['web-file-explorer-persistence']
  );
});

test('factory reset changes select the narrow desktop reset lane only', () => {
  const plan = planFor(['apps/desktop/src/desktop-factory-reset.ts']);

  assert.equal(plan.risk.category, 'desktop-ipc-reset');
  assert.deepEqual(plan.lanes, ['desktop-ipc-reset', 'unit']);
  assert.equal(plan.jobs.prepare_desktop, true);
  assert.equal(plan.jobs.desktop_e2e_pr, true);
  assert.equal(plan.jobs.web_e2e_pr, false);
  assert.deepEqual(
    plan.desktopE2eMatrix.include.map((entry) => entry.lane),
    ['desktop-ipc-reset']
  );
});

test('full-risk changes select release lanes except long soak by default', () => {
  const plan = planFor(['turbo.jsonc']);

  assert.equal(plan.risk.category, 'full-release-high-risk');
  assert.equal(plan.lanes.includes('full'), false);
  assert.equal(plan.lanes.includes('coverage-db'), false);
  assert.equal(plan.lanes.includes('coverage-full'), false);
  assert.equal(plan.lanes.includes('unit'), true);
  assert.equal(plan.lanes.includes('web-e2e'), true);
  assert.equal(plan.lanes.includes('desktop'), true);
  assert.equal(plan.lanes.includes('embedding'), true);
  assert.equal(plan.jobs.unit_coverage, false);
  assert.equal(plan.jobs.unit_affected, true);
  assert.equal(plan.jobs.prepare_web, true);
  assert.equal(plan.jobs.web_e2e_pr, true);
  assert.equal(plan.jobs.prepare_desktop, true);
  assert.equal(plan.jobs.desktop_e2e_pr, true);
  assert.equal(plan.lanes.includes('long-soak-release-only'), false);
  assert.deepEqual(
    plan.desktopE2eMatrix.include.map((entry) => entry.lane),
    [
      'desktop-smoke',
      'desktop-ipc-reset',
      'desktop-runtime-hosts',
      'desktop-db-storage',
      'desktop-full-regression-shard-1-of-4',
      'desktop-full-regression-shard-2-of-4',
      'desktop-full-regression-shard-3-of-4',
      'desktop-full-regression-shard-4-of-4',
      'desktop-embedding-diagnostics',
      'desktop-llm-host-recovery',
    ]
  );
});

test('desktop full regression plan shards the serial Playwright suite', () => {
  const plan = planFor(['apps/desktop/src/main.ts']);
  const shards = plan.desktopE2eMatrix.include.filter((entry) =>
    entry.lane.startsWith('desktop-full-regression-shard-')
  );

  assert.equal(shards.length, 4);
  assert.deepEqual(
    shards.map((entry) => entry.shardIndex),
    [1, 2, 3, 4]
  );
  assert.deepEqual(
    shards.map((entry) => entry.shardTotal),
    [4, 4, 4, 4]
  );
  for (const shard of shards) {
    assert.match(shard.command, /--project=regression/);
    assert.match(shard.command, /--workers=1/);
    assert.match(shard.command, /--grep-invert="@desktop-embedding-"/);
    assert.match(shard.command, new RegExp(`--shard=${shard.shardIndex}/4`));
    assert.equal(shard.tagContract, 'regression project with @desktop-embedding-* inverted');
    assert.equal(shard.timeoutMinutes, 15);
  }
});

test('full-risk desktop plan assigns each concurrent lane a unique display', () => {
  const plan = planFor(['turbo.jsonc']);
  const displays = plan.desktopE2eMatrix.include.map((entry) => entry.display);

  assert.equal(new Set(displays).size, displays.length);
});

test('desktop embedding plan preserves current regression spec coverage', () => {
  const plan = planFor(['packages/embeddings/src/worker/embedding-worker.ts']);
  const [entry] = plan.desktopE2eMatrix.include;

  assert.equal(entry.lane, 'desktop-embedding-diagnostics');
  assert.match(entry.command, /embedding-worker-renderer\.crash-a\.desktop\.test\.ts/);
  assert.match(entry.command, /@desktop-embedding-mixed/);
  assert.doesNotMatch(entry.command, /@desktop-embedding-crash/);
  assert.equal(entry.timeoutMinutes, 20);
});

test('renderGithubOutputs emits machine-readable job switches and matrices', () => {
  const plan = planFor(['docs/architecture-reset/ci-computed-risk-plan-onboarding.html']);
  const outputs = renderGithubOutputs(plan);

  assert.match(outputs, /^plan-json=\{.*\}$/m);
  assert.match(outputs, /^required-jobs-json=\["plan","docs-static"\]$/m);
  assert.match(outputs, /^run-docs-static=true$/m);
  assert.match(outputs, /^run-unit-affected=false$/m);
  assert.match(outputs, /^unit-mode=affected-packages$/m);
  assert.match(outputs, /^web-e2e-matrix=\{"include":\[\]\}$/m);
  assert.doesNotMatch(outputs, /ci:prove/);
  assert.doesNotMatch(outputs, /ci:verify-proof/);
  assert.doesNotMatch(outputs, /\.ci\/proof\/latest\.json/);
});

test('parsePlanArgs accepts explicit file lists for deterministic fixture tests', () => {
  assert.deepEqual(parsePlanArgs(['--files', 'docs/a.md,scripts/ci-plan.mjs']), {
    base: 'origin/main',
    eventName: 'pull_request',
    files: ['docs/a.md', 'scripts/ci-plan.mjs'],
    head: 'HEAD',
  });
});

test('parsePlanArgs maps github output flag to the writer option', () => {
  assert.deepEqual(parsePlanArgs(['--github-output', '/tmp/github-output']), {
    base: 'origin/main',
    eventName: 'pull_request',
    githubOutput: '/tmp/github-output',
    head: 'HEAD',
  });
});

test('collectCiPlan marks explicit file plans as fixture-sourced', async () => {
  const plan = await collectCiPlan({
    eventName: 'pull_request',
    files: ['docs/a.md'],
  });

  assert.equal(plan.selectionSource, 'files-fixture');
  assert.equal(plan.baseSha, '1111111111111111111111111111111111111111');
});
