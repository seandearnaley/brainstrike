import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { buildPlan, CI_GATE_PLAN_IDS } from '../check.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readRepoFile = (relativePath) => readFileSync(path.join(repoRoot, relativePath), 'utf8');
const representativeCommand =
  'pnpm run verify:mcp -- --profile pr --output artifacts/pr-evidence.json';
const exhaustiveCommand =
  'pnpm run verify:mcp -- --profile exhaustive --output artifacts/exhaustive-evidence.json';

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

test('PR and exhaustive lanes use the same command apart from profile and output', () => {
  const normalize = (command) =>
    command
      .replace(/--profile \S+/, '--profile PROFILE')
      .replace(/--output \S+/, '--output OUTPUT');
  assert.equal(normalize(representativeCommand), normalize(exhaustiveCommand));

  const packageJson = JSON.parse(readRepoFile('package.json'));
  assert.equal(packageJson.scripts['verify:mcp'], 'node scripts/run-mcp-verification.mjs');
});

test('living contracts publish the exact local and CI commands', () => {
  const providerContract = readRepoFile('docs/agents/assistant-providers.md');
  const ciContract = readRepoFile('docs/agents/ci-quality.md');

  for (const command of [representativeCommand, exhaustiveCommand]) {
    assert.match(providerContract, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(ciContract, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(providerContract, /Evidence schema `1\.1\.0`/u);
  assert.match(ciContract, /evidence-schema `1\.1\.0`/u);
  for (const contract of [providerContract, ciContract]) {
    assert.match(contract, /protocol-lab-only/u);
  }
});
