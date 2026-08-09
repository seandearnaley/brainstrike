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

function read(relativePath) {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
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

test('REAL REPO: pull-request E2E jobs invoke both smoke lane scripts', () => {
  const workflow = parseYaml(read('.github/workflows/test.yml'));
  assert.ok(workflow.on?.pull_request, 'test.yml must run on pull requests');

  const jobRuns = (jobId) =>
    workflow.jobs[jobId].steps
      .map((step) => step.run)
      .filter((run) => typeof run === 'string')
      .join('\n');

  assert.match(jobRuns('web-e2e'), /pnpm --filter @brainstrike\/web run test:e2e:lane:smoke/);
  assert.match(jobRuns('desktop-e2e'), /pnpm run test:e2e:lane:smoke/);
});
