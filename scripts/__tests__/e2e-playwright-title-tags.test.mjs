import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  findTaggedPlaywrightTitleRanges,
  hasPlaywrightTitleTag,
  isInsideRange,
  listPlaywrightTitleEntries,
} from '../e2e-playwright-title-tags.mjs';

test('literal mode tables produce all registered titles and inherited tags', () => {
  const source = `
test.describe('Retirement @desktop-embedding-retirement', () => {
  for (const mode of ['quit-and-relaunch', 'reset-and-reuse', 'quit-during-reset'] as const) {
    test(\`\${mode} joins active native inference\`, async () => {});
  }
});
test('after loop', async () => {});
`;
  assert.deepEqual(
    listPlaywrightTitleEntries(source, 'retirement.test.ts')
      .filter((entry) => entry.kind === 'test')
      .map((entry) => entry.titlePath),
    [
      'Retirement @desktop-embedding-retirement quit-and-relaunch joins active native inference',
      'Retirement @desktop-embedding-retirement reset-and-reuse joins active native inference',
      'Retirement @desktop-embedding-retirement quit-during-reset joins active native inference',
      'after loop',
    ]
  );
});

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

// Playwright greps against `TestCase._grepTitleWithTags()` — for each ancestor
// suite its title THEN its tags, then the test's own title, then its own tags.
// Tags from the `{ tag }` options form are NOT in any title string, so a parser
// reading title literals only is wrong in both directions. Every expectation
// below was cross-checked against real Playwright 1.61 `--list`.
test('listPlaywrightTitleEntries folds options-form tags into titlePath', () => {
  const source = `
test.describe('Outer suite', { tag: '@smoke' }, () => {
  test('inherits the suite tag', async () => {});
  test('own tag too', { tag: '@web-lane' }, async () => {});
});
test.describe('Plain suite', () => {
  test('array tags', { tag: ['@a-one', '@a-two'] }, async () => {});
  test('untagged leaf', async () => {});
});
`;

  assert.deepEqual(
    listPlaywrightTitleEntries(source, 'tagopts.test.ts')
      .filter((entry) => entry.kind === 'test')
      .map((entry) => entry.titlePath),
    [
      'Outer suite @smoke inherits the suite tag',
      'Outer suite @smoke own tag too @web-lane',
      'Plain suite array tags @a-one @a-two',
      'Plain suite untagged leaf',
    ]
  );
});

test('findTaggedPlaywrightTitleRanges sees a tag declared in the options form', () => {
  // The two sibling consumers ask "is this source position inside a tagged
  // block". Before options-form tags were parsed, a describe tagged this way was
  // invisible to them, so both would have reported false positives on it.
  const source = `
test.describe('Factory Reset recovery', { tag: '@destructive' }, () => {
  test('nested flow', async ({ page }) => {
    await page.getByText('Factory Reset').click();
  });
});
`;

  const ranges = findTaggedPlaywrightTitleRanges(source, 'reset.test.ts', '@destructive');
  assert.equal(ranges.length, 1);
  assert.equal(isInsideRange(source.lastIndexOf('Factory Reset'), ranges), true);
});

test('listPlaywrightTitleEntries flags tags it cannot resolve statically', () => {
  const dynamic = "test('dynamic', { tag: LANE }, async () => {});\n";
  const spread = "test('spread', { ...base, tag: '@x' }, async () => {});\n";
  const identifierDetails = "test('opaque', SHARED_DETAILS, async () => {});\n";
  const literal = "test('literal', { tag: '@x' }, async () => {});\n";

  for (const [label, source] of [
    ['dynamic', dynamic],
    ['spread', spread],
    ['identifierDetails', identifierDetails],
  ]) {
    const [entry] = listPlaywrightTitleEntries(source, 'd.test.ts');
    assert.equal(entry.tagsUnresolved, true, `${label} must be reported as unresolved`);
  }

  const [resolved] = listPlaywrightTitleEntries(literal, 'd.test.ts');
  assert.equal(resolved.tagsUnresolved, false);
  assert.deepEqual(resolved.tags, ['@x']);
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
