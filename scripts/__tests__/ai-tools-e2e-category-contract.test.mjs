import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AI_TOOLS_SPECS = [
  'apps/web/e2e/settings-tools-and-diagnostics.test.ts',
  'apps/desktop/e2e/tools-settings.desktop.test.ts',
];

function categoryLabelViolations(source) {
  const violations = [];

  if (!/\bTOOL_CATEGORIES\b/.test(source)) {
    violations.push('does not import TOOL_CATEGORIES');
  }
  if (!/TOOL_CATEGORIES\[NATIVE_TOOL_DEFAULTS\[NATIVE_TOOL_ID\]\.category\]\.label/.test(source)) {
    violations.push('does not derive the category label from the native-tool contract');
  }
  if (!/getByRole\('option', \{ exact: true, name: TOOL_CATEGORY_LABEL \}\)/.test(source)) {
    violations.push('does not select the category option through TOOL_CATEGORY_LABEL');
  }
  if (/getByRole\('option', \{ name: 'Retrieval' \}\)/.test(source)) {
    violations.push('still hardcodes the Retrieval presentation label');
  }

  return violations;
}

test('MONEY TEST: a hardcoded AI Tools category label violates the contract', () => {
  const source = `
    import { NATIVE_TOOL_DEFAULTS } from '@brainstrike/assistant-contract/tool-metadata';
    const NATIVE_TOOL_ID = 'brainstrike.readWorkspaceContext';
    await page.getByRole('option', { name: 'Retrieval' }).click();
  `;

  assert.deepEqual(categoryLabelViolations(source), [
    'does not import TOOL_CATEGORIES',
    'does not derive the category label from the native-tool contract',
    'does not select the category option through TOOL_CATEGORY_LABEL',
    'still hardcodes the Retrieval presentation label',
  ]);
});

for (const relativePath of AI_TOOLS_SPECS) {
  test(`REAL REPO: ${relativePath} derives its category label from tool metadata`, () => {
    const source = readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
    assert.deepEqual(categoryLabelViolations(source), []);
  });
}
