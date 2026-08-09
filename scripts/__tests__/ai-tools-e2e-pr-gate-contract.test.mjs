import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { listPlaywrightTitleEntries } from '../e2e-playwright-title-tags.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WEB_SPEC = 'apps/web/e2e/settings-tools-and-diagnostics.test.ts';
const DESKTOP_SPEC = 'apps/desktop/e2e/tools-settings.desktop.test.ts';

function read(relativePath) {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function untaggedTitles(source, fileName, tag) {
  return listPlaywrightTitleEntries(source, fileName)
    .filter((entry) => entry.kind === 'test' && !entry.titlePath.includes(tag))
    .map((entry) => entry.titlePath);
}

test('MONEY TEST: the PR-gate check catches a tools-settings title without its smoke tag', () => {
  const source = "test.describe('Tools', () => { test('filters', async () => {}); });\n";
  assert.deepEqual(untaggedTitles(source, 'tools.test.ts', '@smoke'), ['Tools filters']);
});

test('REAL REPO: every web AI Tools settings title is selected by Web E2E smoke', () => {
  const source = read(WEB_SPEC);
  assert.deepEqual(untaggedTitles(source, WEB_SPEC, '@web-smoke'), []);

  const webPackage = JSON.parse(read('apps/web/package.json'));
  assert.match(webPackage.scripts['test:e2e:lane:smoke'], /--grep ["\\']@web-smoke["\\']/);
});

test('REAL REPO: every desktop AI Tools settings title is selected by Desktop E2E smoke', () => {
  const source = read(DESKTOP_SPEC);
  assert.deepEqual(untaggedTitles(source, DESKTOP_SPEC, '@smoke'), []);

  const desktopPackage = JSON.parse(read('apps/desktop/package.json'));
  const smokeCommand = desktopPackage.scripts['test:e2e:lane:smoke'];
  assert.match(smokeCommand, /e2e\/tools-settings\.desktop\.test\.ts/);
  assert.match(smokeCommand, /--grep=["\\']@smoke["\\']/);
});

test('REAL REPO: required PR checks invoke both smoke lane scripts', () => {
  const workflow = read('.github/workflows/test.yml');
  assert.match(workflow, /pnpm --filter @brainstrike\/web run test:e2e:lane:smoke/);
  assert.match(workflow, /pnpm run test:e2e:lane:smoke/);
});
