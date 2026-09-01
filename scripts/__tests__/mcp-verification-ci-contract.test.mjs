import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { OFFICIAL_AUTH_CONFORMANCE_PROFILES } from '../../packages/assistant-contract/src/official-auth-conformance.ts';

import { buildPlan, CI_GATE_PLAN_IDS } from '../check.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readRepoFile = (relativePath) => readFileSync(path.join(repoRoot, relativePath), 'utf8');
const representativeCommand =
  'pnpm run verify:mcp -- --profile pr --output artifacts/pr-evidence.json';
const exhaustiveCommand =
  'pnpm run verify:mcp -- --profile exhaustive --output artifacts/exhaustive-evidence.json';
const officialBaselineCommand = 'pnpm run verify:mcp:official';
const officialModernCommand = 'pnpm run verify:mcp:official -- --profile modern-closeout';

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

test('exhaustive verification is schedule and manual only with bounded artifact retention', () => {
  const workflow = parseYaml(readRepoFile('.github/workflows/mcp-verification.yml'));
  assert.deepEqual(Object.keys(workflow.on).sort(), ['schedule', 'workflow_dispatch']);
  assert.equal(workflow.on.schedule.length, 1);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
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

test('official prerelease auth conformance is a bounded advisory job with sanitized evidence', () => {
  const descriptor = OFFICIAL_AUTH_CONFORMANCE_PROFILES.baseline;
  const workflow = parseYaml(readRepoFile('.github/workflows/mcp-verification.yml'));
  const job = workflow.jobs.official_auth;
  assert.ok(job);
  assert.equal(job['continue-on-error'], true);
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

test('modern-only auth closeout is an independent bounded advisory job', () => {
  const descriptor = OFFICIAL_AUTH_CONFORMANCE_PROFILES['modern-closeout'];
  const workflow = parseYaml(readRepoFile('.github/workflows/mcp-verification.yml'));
  const job = workflow.jobs.official_modern_auth;
  assert.ok(job);
  assert.equal(job['continue-on-error'], true);
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
  const providerContract = readRepoFile('docs/agents/assistant-providers.md');
  const ciContract = readRepoFile('docs/agents/ci-quality.md');

  for (const command of [representativeCommand, exhaustiveCommand]) {
    assert.match(providerContract, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(ciContract, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  for (const command of [officialBaselineCommand, officialModernCommand]) {
    const exactLine = new RegExp(`^${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'mu');
    assert.match(providerContract, exactLine);
    assert.match(ciContract, exactLine);
  }
  assert.match(providerContract, /Evidence schema `1\.1\.0`/u);
  assert.match(ciContract, /evidence-schema `1\.1\.0`/u);
  for (const contract of [providerContract, ciContract]) {
    assert.match(contract, /protocol-lab-only/u);
  }
});
