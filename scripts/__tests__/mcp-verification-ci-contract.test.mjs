import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { OFFICIAL_AUTH_CONFORMANCE_PROFILES } from '../../packages/assistant-contract/src/official-auth-conformance.ts';

import { buildPlan, CI_GATE_PLAN_IDS } from '../check.mjs';
import { buildOfficialAuthEvidence } from '../run-official-mcp-client-conformance.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const requireDesktop = createRequire(path.join(repoRoot, 'apps/desktop/package.json'));
const { minimatch } = requireDesktop('minimatch');
const readRepoFile = (relativePath) => readFileSync(path.join(repoRoot, relativePath), 'utf8');
const representativeCommand =
  'pnpm run verify:mcp -- --profile pr --output artifacts/pr-evidence.json';
const exhaustiveCommand =
  'pnpm run verify:mcp -- --profile exhaustive --output artifacts/exhaustive-evidence.json';
const officialBaselineCommand = 'pnpm run verify:mcp:official';
const officialCoreCommand = 'pnpm run verify:mcp:official -- --profile core';
const officialModernCommand = 'pnpm run verify:mcp:official -- --profile modern-closeout';
const officialJobIds = ['official_auth', 'official_core', 'official_modern_auth'];
const officialGreenRunUrls = [
  'https://github.com/seandearnaley/brainstrike/actions/runs/33541373505',
  'https://github.com/seandearnaley/brainstrike/actions/runs/33545728828',
  'https://github.com/seandearnaley/brainstrike/actions/runs/33545945643',
];

function findStep(workflow, jobName, stepName) {
  const step = workflow.jobs[jobName].steps.find((candidate) => candidate.name === stepName);
  assert.ok(step, `missing ${jobName} step ${stepName}`);
  return step;
}

test('required PR Static and the local check consume the representative command', () => {
  const workflow = parseYaml(readRepoFile('.github/workflows/test.yml'));
  const step = findStep(workflow, 'static', 'MCP representative verification');
  assert.equal(step.run, representativeCommand);
  assert.equal(step['continue-on-error'], undefined);

  const planStep = buildPlan({ e2e: false, fast: true, install: false }).find(
    (candidate) => candidate.id === 'mcp-verification'
  );
  assert.deepEqual(planStep, {
    command: representativeCommand,
    id: 'mcp-verification',
    label: 'MCP representative verification',
  });
  assert.deepEqual(CI_GATE_PLAN_IDS.get('static › MCP representative verification'), [
    'mcp-verification',
  ]);
});

test('the Tasks and Apps release proofs ride the required PR lane and the exhaustive lane', () => {
  // BST-1566 / BST-1572: the in-process cases are in the representative
  // profile (required PR Static step), the loopback cases in the exhaustive
  // profile (scheduled/manual verify job), and each run ceiling fits its step.
  const manifest = readRepoFile('packages/mcp-test-lab/src/runner-manifest.ts');
  const profileBlock = (id) => {
    const match = manifest.match(new RegExp(`${id}: Object\\.freeze\\(\\[([^\\]]*)\\]`, 'u'));
    assert.ok(match, `missing ${id} profile block`);
    return match[1];
  };
  const pr = profileBlock('pr');
  assert.match(pr, /'modern-tasks-in-process'/u);
  assert.match(pr, /'modern-apps-in-process'/u);
  const caseIds = manifest.match(/MCP_LAB_RUNNER_CASE_IDS = Object\.freeze\(\[([^\]]*)\]/u);
  assert.ok(caseIds);
  assert.match(caseIds[1], /'modern-tasks-loopback'/u);
  assert.match(caseIds[1], /'modern-apps-loopback'/u);
  const runCeiling = (id) => {
    const match = manifest.match(
      new RegExp(
        `${id}: Object\\.freeze\\(\\{ caseTimeoutMs: ([\\d_]+), runTimeoutMs: ([\\d_]+) \\}`,
        'u'
      )
    );
    assert.ok(match, `missing ${id} timeouts`);
    return Number(match[2].replaceAll('_', ''));
  };
  const staticWorkflow = parseYaml(readRepoFile('.github/workflows/test.yml'));
  const staticStep = findStep(staticWorkflow, 'static', 'MCP representative verification');
  assert.equal(staticStep.run, representativeCommand);
  const verification = parseYaml(readRepoFile('.github/workflows/mcp-verification.yml'));
  const verifyStep = findStep(verification, 'verify', 'Run exhaustive MCP verification');
  assert.equal(verifyStep.run, exhaustiveCommand);
  assert.ok(runCeiling('exhaustive') < verifyStep['timeout-minutes'] * 60_000);
  assert.ok(runCeiling('pr') < verification.jobs.verify['timeout-minutes'] * 60_000);
});

test('verification runs on main pushes, schedule, and manual dispatch with bounded artifact retention', () => {
  const workflow = parseYaml(readRepoFile('.github/workflows/mcp-verification.yml'));
  assert.deepEqual(Object.keys(workflow.on).sort(), ['push', 'schedule', 'workflow_dispatch']);
  // BST-1582: main pushes run only the official conformance jobs; docs-only
  // merges cannot regress client conformance and skip the workflow entirely.
  assert.deepEqual(workflow.on.push, {
    branches: ['main'],
    'paths-ignore': ['docs/**', '**/*.md'],
  });
  assert.equal(workflow.on.schedule.length, 1);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  // Overlapping main-push runs serialize instead of cancelling: a cancelled run
  // would silently skip the gate for an intermediate merge commit.
  assert.deepEqual(workflow.concurrency, {
    'cancel-in-progress': false,
    group: `${'$'}{{ github.workflow }}-${'$'}{{ github.ref }}`,
  });
  // The exhaustive lane stays schedule/manual; the PR-lane representative
  // profile already covers every merge.
  assert.equal(workflow.jobs.verify.if, `${'$'}{{ github.event_name != 'push' }}`);
  for (const jobId of officialJobIds) {
    assert.equal(workflow.jobs[jobId].if, undefined, `${jobId} must run on main pushes`);
  }
  assert.equal(workflow.jobs.verify['timeout-minutes'], 10);

  const verifyStep = findStep(workflow, 'verify', 'Run exhaustive MCP verification');
  assert.equal(verifyStep.run, exhaustiveCommand);
  assert.equal(verifyStep['timeout-minutes'], 8);
  assert.equal(verifyStep['continue-on-error'], undefined);

  const uploadStep = findStep(workflow, 'verify', 'Upload MCP verification evidence');
  assert.ok(
    workflow.jobs.verify.steps.indexOf(uploadStep) > workflow.jobs.verify.steps.indexOf(verifyStep)
  );
  assert.equal(uploadStep.uses, 'actions/upload-artifact@v7');
  assert.equal(uploadStep.if, undefined);
  assert.equal(uploadStep['continue-on-error'], undefined);
  assert.equal(uploadStep.with.name, `mcp-verification-${'$'}{{ github.sha }}`);
  assert.equal(uploadStep.with.path, 'packages/mcp-test-lab/artifacts/exhaustive-evidence.json');
  assert.equal(uploadStep.with['if-no-files-found'], 'error');
  assert.equal(uploadStep.with['retention-days'], 14);
});

test('official auth conformance is a bounded required job with sanitized evidence', () => {
  const descriptor = OFFICIAL_AUTH_CONFORMANCE_PROFILES.baseline;
  const workflow = parseYaml(readRepoFile('.github/workflows/mcp-verification.yml'));
  const job = workflow.jobs.official_auth;
  assert.ok(job);
  // BST-1582: the official suites are required gates; a scenario failure fails the workflow.
  assert.equal(job['continue-on-error'], undefined);
  assert.equal(job['timeout-minutes'], descriptor.jobTimeoutMinutes);

  const provisionStep = findStep(workflow, 'official_auth', 'Provision Electron binary');
  assert.equal(provisionStep['timeout-minutes'], descriptor.provisionTimeoutMinutes);
  assert.equal(provisionStep['working-directory'], 'apps/desktop');

  const verifyStep = findStep(workflow, 'official_auth', 'Run official MCP auth conformance');
  assert.equal(verifyStep.run, officialBaselineCommand);
  assert.equal(
    verifyStep['timeout-minutes'],
    descriptor.buildTimeoutMinutes + descriptor.stepTimeoutMinutes
  );
  assert.equal(verifyStep['continue-on-error'], undefined);

  const uploadStep = findStep(workflow, 'official_auth', 'Upload official MCP auth evidence');
  assert.equal(uploadStep.if, `${'$'}{{ always() }}`);
  assert.equal(uploadStep.uses, 'actions/upload-artifact@v7');
  assert.equal(uploadStep.with.name, `mcp-official-auth-${'$'}{{ github.sha }}`);
  assert.equal(uploadStep.with.path, 'packages/mcp-test-lab/artifacts/official-auth-evidence.json');
  assert.equal(uploadStep.with['if-no-files-found'], 'error');
  assert.equal(uploadStep.with['retention-days'], 14);

  const source = readRepoFile('scripts/run-official-mcp-client-conformance.mjs');
  assert.match(source, /packages\/assistant-contract\/src\/official-auth-conformance\.ts/u);
  assert.doesNotMatch(source, /@brainstrike\/assistant-contract\/official-auth-conformance/u);
  assert.match(source, /requireDesktopDependency\('electron'\)/u);
  assert.match(source, /provisionClientRuntime = provisionElectronClientRuntime/u);
  assert.match(source, /provisionClientRuntime: provisionElectronClientRuntime/u);
  assert.doesNotMatch(source, /'--expected-failures'/u);
  assert.doesNotMatch(source, /'--output-dir'/u);
});

test('modern-only auth closeout is an independent bounded required job', () => {
  const descriptor = OFFICIAL_AUTH_CONFORMANCE_PROFILES['modern-closeout'];
  const workflow = parseYaml(readRepoFile('.github/workflows/mcp-verification.yml'));
  const job = workflow.jobs.official_modern_auth;
  assert.ok(job);
  // BST-1582: the official suites are required gates; a scenario failure fails the workflow.
  assert.equal(job['continue-on-error'], undefined);
  assert.equal(job['timeout-minutes'], descriptor.jobTimeoutMinutes);

  const provisionStep = findStep(workflow, 'official_modern_auth', 'Provision Electron binary');
  assert.equal(provisionStep['timeout-minutes'], descriptor.provisionTimeoutMinutes);
  assert.equal(provisionStep['working-directory'], 'apps/desktop');

  const verifyStep = findStep(
    workflow,
    'official_modern_auth',
    'Run official MCP modern auth closeout'
  );
  assert.equal(verifyStep.run, officialModernCommand);
  assert.equal(
    verifyStep['timeout-minutes'],
    descriptor.buildTimeoutMinutes + descriptor.stepTimeoutMinutes
  );
  assert.equal(verifyStep['continue-on-error'], undefined);

  const uploadStep = findStep(
    workflow,
    'official_modern_auth',
    'Upload official MCP modern auth evidence'
  );
  assert.equal(uploadStep.if, `${'$'}{{ always() }}`);
  assert.equal(uploadStep.uses, 'actions/upload-artifact@v7');
  assert.equal(uploadStep.with.name, `mcp-official-modern-auth-${'$'}{{ github.sha }}`);
  assert.equal(
    uploadStep.with.path,
    'packages/mcp-test-lab/artifacts/official-auth-modern-closeout-evidence.json'
  );
  assert.equal(uploadStep.with['if-no-files-found'], 'error');
  assert.equal(uploadStep.with['retention-days'], 14);
});

test('resource-mismatch process proof runs in the required desktop integration lane', async () => {
  const relativeTestPath =
    'src/__tests__/main/official-conformance-client-process.integration.test.ts';
  assert.ok(existsSync(path.join(repoRoot, 'apps/desktop', relativeTestPath)));

  const desktop = JSON.parse(readRepoFile('apps/desktop/package.json'));
  assert.match(
    desktop.scripts['test:integration'],
    /vitest run --config vitest\.integration\.config\.mts/u
  );
  const configUrl = pathToFileURL(
    path.join(repoRoot, 'apps/desktop/vitest.integration.config.mts')
  );
  const { default: integrationConfig } = await import(configUrl.href);
  const include = integrationConfig.test?.include ?? [];
  assert.ok(include.some((glob) => minimatch(relativeTestPath, glob)));

  const workflow = parseYaml(readRepoFile('.github/workflows/test.yml'));
  const step = findStep(workflow, 'unit-shard', 'Pull request affected integration tests');
  assert.match(step.run, /pnpm turbo run test:integration/u);
  assert.equal(step['continue-on-error'], undefined);
});

test('official core conformance is an independent bounded required job', () => {
  const descriptor = OFFICIAL_AUTH_CONFORMANCE_PROFILES.core;
  const workflow = parseYaml(readRepoFile('.github/workflows/mcp-verification.yml'));
  const job = workflow.jobs.official_core;
  assert.ok(job);
  // BST-1582: the official suites are required gates; a scenario failure fails the workflow.
  assert.equal(job['continue-on-error'], undefined);
  assert.equal(job['timeout-minutes'], descriptor.jobTimeoutMinutes);

  const provisionStep = findStep(workflow, 'official_core', 'Provision Electron binary');
  assert.equal(provisionStep['timeout-minutes'], descriptor.provisionTimeoutMinutes);
  assert.equal(provisionStep['working-directory'], 'apps/desktop');

  const verifyStep = findStep(workflow, 'official_core', 'Run official MCP core conformance');
  assert.equal(verifyStep.run, officialCoreCommand);
  assert.equal(
    verifyStep['timeout-minutes'],
    descriptor.buildTimeoutMinutes + descriptor.stepTimeoutMinutes
  );

  const uploadStep = findStep(workflow, 'official_core', 'Upload official MCP core evidence');
  assert.equal(uploadStep.if, `${'$'}{{ always() }}`);
  assert.equal(uploadStep.with.name, `mcp-official-core-${'$'}{{ github.sha }}`);
  assert.equal(uploadStep.with.path, descriptor.evidencePath);
  assert.equal(uploadStep.with['if-no-files-found'], 'error');
  assert.equal(uploadStep.with['retention-days'], 14);
});

test('evidence `required` mirrors the absence of continue-on-error on every official job', () => {
  // BST-1582: the evidence field must stay falsifiable against the workflow,
  // not against a second copy of the same intent. Demoting a job back to
  // advisory without touching the evidence claim fails here.
  const workflow = parseYaml(readRepoFile('.github/workflows/mcp-verification.yml'));
  const evidence = buildOfficialAuthEvidence({
    completedAt: '2026-09-01T00:00:01.000Z',
    git: { clean: true, head: 'a'.repeat(40) },
    ledgers: {},
    report: { failureIds: [], waves: [] },
    startedAt: '2026-09-01T00:00:00.000Z',
  });
  for (const jobId of officialJobIds) {
    const job = workflow.jobs[jobId];
    assert.ok(job, `missing job ${jobId}`);
    assert.equal(
      evidence.conformance.required,
      job['continue-on-error'] === undefined,
      `${jobId} gate posture disagrees with the evidence \`required\` claim`
    );
  }
});

test('PR and exhaustive lanes use the same command apart from profile and output', () => {
  const normalize = (command) =>
    command
      .replace(/--profile \S+/, '--profile PROFILE')
      .replace(/--output \S+/, '--output OUTPUT');
  assert.equal(normalize(representativeCommand), normalize(exhaustiveCommand));

  const packageJson = JSON.parse(readRepoFile('package.json'));
  assert.equal(packageJson.scripts['verify:mcp'], 'node scripts/run-mcp-verification.mjs');
  assert.equal(
    packageJson.scripts['verify:mcp:official'],
    'pnpm --filter @brainstrike/assistant-contract build && pnpm --filter @brainstrike/desktop prebuild && pnpm --filter @brainstrike/desktop build:main && node scripts/run-official-mcp-client-conformance.mjs'
  );
});

test('living contracts publish the exact local and CI commands', () => {
  // BST-1590: conformance prose lives in mcp-conformance.md, not the provider contract.
  const conformanceContract = readRepoFile('docs/agents/mcp-conformance.md');
  assert.match(
    conformanceContract,
    /Runtime SDK versions match installed packages; fixture source tags and commits stay historical/u
  );
  const ciContract = readRepoFile('docs/agents/ci-quality.md');

  for (const command of [representativeCommand, exhaustiveCommand]) {
    assert.match(conformanceContract, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(ciContract, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  for (const command of [officialBaselineCommand, officialCoreCommand, officialModernCommand]) {
    const exactLine = new RegExp(`^${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'mu');
    assert.match(conformanceContract, exactLine);
    assert.match(ciContract, exactLine);
  }
  assert.match(conformanceContract, /Evidence schema `1\.1\.0`/u);
  assert.match(ciContract, /evidence-schema `1\.1\.0`/u);
  for (const contract of [conformanceContract, ciContract]) {
    assert.match(contract, /protocol-lab-only/u);
  }
  // The POSIX teardown ruling is behaviour, not commentary: EPERM on a group of
  // our own descendants is the post-reap race, so it must neither fail the
  // invocation nor be read as success.
  assert.match(conformanceContract, /`ESRCH` is the only proof the group is gone/u);
  // The ruling is portable; the kernel mechanism behind it is not. Recording
  // only the Darwin half would mislead the next reader into pinning EPERM.
  assert.match(conformanceContract, /The ruling ports but its mechanism does not/u);
});

test('living contracts link official conformance evidence and require dispatch URLs in PRs', () => {
  const conformanceContract = readRepoFile('docs/agents/mcp-conformance.md');
  const ciContract = readRepoFile('docs/agents/ci-quality.md');

  for (const runUrl of officialGreenRunUrls) {
    assert.ok(conformanceContract.includes(runUrl), `missing run URL: ${runUrl}`);
  }
  assert.match(conformanceContract, /28\/28 baseline auth/u);
  assert.match(conformanceContract, /11\/11 modern auth closeout/u);
  assert.match(
    ciContract,
    /pull request touching official MCP conformance must link its workflow-dispatch run URL/u
  );
});

test('the conformance contract is routed once from AGENTS.md and owns the moved prose', () => {
  // BST-1590 rule 7: conformance/verification sections no longer live in the
  // provider contract, so every landing stops rewriting that file.
  const agents = readRepoFile('AGENTS.md');
  const providerContract = readRepoFile('docs/agents/assistant-providers.md');
  const conformanceContract = readRepoFile('docs/agents/mcp-conformance.md');
  const ciContract = readRepoFile('docs/agents/ci-quality.md');
  const routeRows = agents
    .split('\n')
    .filter((row) => row.startsWith('|') && row.includes('docs/agents/mcp-conformance.md'));
  assert.equal(
    routeRows.length,
    1,
    'AGENTS.md must route mcp-conformance.md from exactly one table row'
  );
  assert.match(conformanceContract, /^## MCP verification harness$/mu);
  assert.match(conformanceContract, /^## Official conformance evidence \(BST-1589\)$/mu);
  assert.doesNotMatch(providerContract, /^### MCP verification harness$/mu);
  assert.doesNotMatch(providerContract, /run-official-mcp-client-conformance\.mjs/u);
  assert.match(providerContract, /docs\/agents\/mcp-conformance\.md/u);
  assert.match(ciContract, /#### MCP 2026 fleet working agreements \(BST-1590\)/u);
});
