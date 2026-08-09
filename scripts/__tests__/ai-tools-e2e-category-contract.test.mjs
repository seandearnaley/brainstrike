import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const E2E_ROOTS = ['apps/web/e2e', 'apps/desktop/e2e'];
const HARDCODED_OPTION_NAME = /getByRole\(\s*['"]option['"]\s*,\s*\{[^}]*name:\s*['"`]/;

function collectE2eSpecs(relativeDirectory) {
  const specs = [];

  for (const entry of readdirSync(path.join(REPO_ROOT, relativeDirectory), {
    withFileTypes: true,
  })) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      specs.push(...collectE2eSpecs(relativePath));
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      specs.push(relativePath);
    }
  }

  return specs;
}

const AI_TOOLS_SPECS = E2E_ROOTS.flatMap(collectE2eSpecs).filter((relativePath) => {
  const source = readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
  return source.includes('category-filter') && source.includes('brainstrike.readWorkspaceContext');
});

function categoryLabelViolations(source) {
  const violations = [];

  if (
    !/import\s*\{[^}]*\bTOOL_CATEGORIES\b[^}]*\}\s*from\s*['"]@brainstrike\/assistant-contract\/tool-metadata['"]/.test(
      source
    )
  ) {
    violations.push('does not import TOOL_CATEGORIES');
  }
  if (
    !/TOOL_CATEGORIES\s*\[\s*NATIVE_TOOL_DEFAULTS\s*\[\s*NATIVE_TOOL_ID\s*\]\s*\.category\s*\]\s*\.label/.test(
      source
    )
  ) {
    violations.push('does not derive the category label from the native-tool contract');
  }
  if (
    !/getByRole\(\s*['"]option['"]\s*,\s*\{[^}]*name:\s*TOOL_CATEGORY_LABEL\b[^}]*\}\s*\)/.test(
      source
    )
  ) {
    violations.push('does not select the category option through TOOL_CATEGORY_LABEL');
  }
  if (HARDCODED_OPTION_NAME.test(source)) {
    violations.push('hardcodes an option presentation label');
  }

  return violations;
}

test('MONEY TEST: one derived selector cannot hide a second hardcoded option label', () => {
  const source = `
    import {
      NATIVE_TOOL_DEFAULTS,
      TOOL_CATEGORIES,
    } from '@brainstrike/assistant-contract/tool-metadata';
    const NATIVE_TOOL_ID = 'brainstrike.readWorkspaceContext';
    const TOOL_CATEGORY_LABEL = TOOL_CATEGORIES[
      NATIVE_TOOL_DEFAULTS[NATIVE_TOOL_ID].category
    ].label;
    await page.getByRole(
      'option',
      { exact: true, name: TOOL_CATEGORY_LABEL }
    ).click();
    await page.getByRole('option', { exact: true, name: 'Analysis' }).click();
  `;

  assert.deepEqual(categoryLabelViolations(source), ['hardcodes an option presentation label']);
});

test('discovers both current readWorkspaceContext category-filter specs', () => {
  assert.ok(
    AI_TOOLS_SPECS.length >= 2,
    'expected at least the web and desktop readWorkspaceContext category-filter specs'
  );
});

for (const relativePath of AI_TOOLS_SPECS) {
  test(`REAL REPO: ${relativePath} derives its category label from tool metadata`, () => {
    const source = readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
    assert.deepEqual(categoryLabelViolations(source), []);
  });
}
