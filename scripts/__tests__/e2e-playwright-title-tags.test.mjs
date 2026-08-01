import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  findTaggedPlaywrightTitleRanges,
  hasPlaywrightTitleTag,
  isInsideRange,
  listPlaywrightTitleEntries,
} from '../e2e-playwright-title-tags.mjs';

test('findTaggedPlaywrightTitleRanges uses AST ranges instead of brace counting', () => {
  const source = `
test.describe('Factory Reset recovery @destructive', () => {
  const braceInString = '}';
  const braceInTemplate = \`{\`;
  // }
  test('nested flow', async ({ page }) => {
    await page.getByText('Factory Reset').click();
  });
});

test('untagged flow', async ({ page }) => {
  await page.goto('/settings/factory-reset');
});
`;

  const ranges = findTaggedPlaywrightTitleRanges(
    source,
    'factory-reset-recovery.test.ts',
    '@destructive'
  );

  assert.equal(ranges.length, 1);
  assert.equal(isInsideRange(source.lastIndexOf('Factory Reset'), ranges), true);
  assert.equal(isInsideRange(source.indexOf('/settings/factory-reset'), ranges), false);
});

test('hasPlaywrightTitleTag ignores comments and ordinary string literals', () => {
  const source = `
// @stateful
const label = '@stateful';
test('ordinary flow', async () => {});
`;

  assert.equal(hasPlaywrightTitleTag(source, 'ordinary.test.ts', '@stateful'), false);
});

// `titlePath` is what `--grep` / `--grep-invert` and a project's `grep` match
// against, so lane-coverage modelling depends on describe tags reaching the
// leaves. Cross-checked against real Playwright 1.61 `--list` output: a tag on
// the describe selects the nested test.
test('listPlaywrightTitleEntries gives each test the tags it inherits from its describes', () => {
  const source = `
test.describe('Outer @stateful', () => {
  test.describe('Inner @web-indexing', () => {
    test('leaf', async () => {});
  });
});
test('top level @web-smoke', async () => {});
`;

  const tests = listPlaywrightTitleEntries(source, 'nested.test.ts').filter(
    (entry) => entry.kind === 'test'
  );

  assert.deepEqual(
    tests.map((entry) => entry.titlePath),
    ['Outer @stateful Inner @web-indexing leaf', 'top level @web-smoke']
  );
  assert.deepEqual(
    listPlaywrightTitleEntries(source, 'nested.test.ts')
      .filter((entry) => entry.kind === 'describe')
      .map((entry) => entry.title),
    ['Outer @stateful', 'Inner @web-indexing']
  );
});

test('listPlaywrightTitleEntries ignores non-title calls that look similar', () => {
  const source = `
test.describe.configure({ mode: 'serial' });
test.use({ locale: 'en-US' });
const notATest = describe('decoy', () => {});
test('real leaf', async () => {});
`;

  assert.deepEqual(
    listPlaywrightTitleEntries(source, 'decoy.test.ts').map((entry) => entry.titlePath),
    ['real leaf']
  );
});

test('hasPlaywrightTitleTag detects Playwright title modifiers', () => {
  const source = `
test.describe.serial('Settings persistence @stateful', () => {});
test.only('Focused flow @destructive', () => {});
`;

  assert.equal(hasPlaywrightTitleTag(source, 'settings.test.ts', '@stateful'), true);
  assert.equal(hasPlaywrightTitleTag(source, 'settings.test.ts', '@destructive'), true);
});
