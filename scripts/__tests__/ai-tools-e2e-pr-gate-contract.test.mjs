import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { listPlaywrightTitleEntries } from '../e2e-playwright-title-tags.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WEB_SPEC = 'apps/web/e2e/settings-tools-and-diagnostics.test.ts';
const DESKTOP_SPEC = 'apps/desktop/e2e/tools-settings.desktop.test.ts';
const REQUIRED_PR_E2E_JOB_CONDITION = [
  'always() &&',
  '(',
  "needs.admission.result != 'success' ||",
  '(',
  "github.event_name != 'workflow_dispatch' &&",
  "needs.admission.outputs.admitted == 'true' &&",
  "needs.build.result == 'success'",
  ')',
  ')',
].join(' ');

function read(relativePath) {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function normalizeExpression(expression) {
  return String(expression).replace(/\s+/g, ' ').trim();
}

function stepRunsExactCommand(step, expectedCommand) {
  return typeof step.run === 'string' && normalizeExpression(step.run) === expectedCommand;
}

function untaggedTitles(source, fileName, tag) {
  const testEntries = listPlaywrightTitleEntries(source, fileName).filter(
    (entry) => entry.kind === 'test'
  );
  assert.deepEqual(
    testEntries.filter((entry) => entry.tagsUnresolved).map((entry) => entry.titlePath),
    [],
    `${fileName} must use statically resolvable Playwright tags`
  );

  return testEntries
    .filter((entry) => !entry.titlePath.includes(tag))
    .map((entry) => entry.titlePath);
}

test('MONEY TEST: options-form tags cover only their suite, not an untagged sibling', () => {
  const source = `
    test.describe('Tools', { tag: '@smoke' }, () => {
      test('filters', async () => {});
    });
    test('outside', async () => {});
  `;
  assert.deepEqual(untaggedTitles(source, 'tools.test.ts', '@smoke'), ['outside']);
});

test('MONEY TEST: the smoke matcher rejects disabled lanes and diagnostic suffixes', () => {
  const expectedCommand = 'pnpm run test:e2e:lane:smoke';
  assert.equal(stepRunsExactCommand({ run: expectedCommand }, expectedCommand), true);
  assert.equal(
    stepRunsExactCommand({ run: `${expectedCommand}-disabled` }, expectedCommand),
    false
  );
  assert.equal(
    stepRunsExactCommand({ run: `${expectedCommand} -- --list` }, expectedCommand),
    false
  );
});

test('REAL REPO: every web AI Tools settings title is selected by Web E2E smoke', () => {
  const source = read(WEB_SPEC);
  assert.deepEqual(untaggedTitles(source, WEB_SPEC, '@web-smoke'), []);

  const webPackage = JSON.parse(read('apps/web/package.json'));
  assert.match(webPackage.scripts['test:e2e:lane:smoke'], /--grep ["']@web-smoke["']/);
});

test('REAL REPO: every desktop AI Tools settings title is selected by Desktop E2E smoke', () => {
  const source = read(DESKTOP_SPEC);
  assert.deepEqual(untaggedTitles(source, DESKTOP_SPEC, '@smoke'), []);

  const desktopPackage = JSON.parse(read('apps/desktop/package.json'));
  const smokeCommand = desktopPackage.scripts['test:e2e:lane:smoke'];
  assert.match(smokeCommand, /e2e\/tools-settings\.desktop\.test\.ts/);
  assert.match(smokeCommand, /--grep=["']@smoke["']/);
});

test('REAL REPO: desktop smoke tags remain selected by nightly regression', () => {
  const desktopPackage = JSON.parse(read('apps/desktop/package.json'));
  assert.match(
    desktopPackage.scripts['test:e2e:lane:full-regression'],
    /pnpm run test:e2e:lane:tools-settings-nightly/
  );
  const nightlyCommand = desktopPackage.scripts['test:e2e:lane:tools-settings-nightly'];
  assert.match(nightlyCommand, /e2e\/tools-settings\.desktop\.test\.ts/);
  assert.match(nightlyCommand, /--project=smoke/);
  assert.match(nightlyCommand, /--grep=["']@smoke["']/);
});

test('REAL REPO: pull-request E2E jobs invoke both smoke lane scripts', () => {
  const workflow = parseYaml(read('.github/workflows/test.yml'));
  assert.ok(workflow.on?.pull_request, 'test.yml must run on pull requests');

  const assertRequiredSmokeStep = (jobId, expectedCommand, expectedWorkingDirectory) => {
    const job = workflow.jobs[jobId];
    assert.equal(
      normalizeExpression(job.if),
      REQUIRED_PR_E2E_JOB_CONDITION,
      `${jobId} must retain the PR-admitting job condition`
    );
    const matchingSteps = job.steps.filter((step) => stepRunsExactCommand(step, expectedCommand));
    assert.equal(matchingSteps.length, 1, `${jobId} must have one exact smoke invocation`);
    assert.equal(matchingSteps[0].if, undefined, `${jobId} smoke step must be unconditional`);
    assert.equal(
      matchingSteps[0]['working-directory'],
      expectedWorkingDirectory,
      `${jobId} smoke step must run from the expected workspace directory`
    );
  };

  assertRequiredSmokeStep('web-e2e', 'pnpm --filter @brainstrike/web run test:e2e:lane:smoke');
  assertRequiredSmokeStep(
    'desktop-e2e',
    'dbus-run-session -- pnpm run test:e2e:lane:smoke',
    'apps/desktop'
  );
});
