import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  findTaggedPlaywrightTitleRanges,
  hasPlaywrightTitleTag,
  isInsideRange,
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

test('hasPlaywrightTitleTag detects Playwright title modifiers', () => {
  const source = `
test.describe.serial('Settings persistence @stateful', () => {});
test.only('Focused flow @destructive', () => {});
`;

  assert.equal(hasPlaywrightTitleTag(source, 'settings.test.ts', '@stateful'), true);
  assert.equal(hasPlaywrightTitleTag(source, 'settings.test.ts', '@destructive'), true);
});
