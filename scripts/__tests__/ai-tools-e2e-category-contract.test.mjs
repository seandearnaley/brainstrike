import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const E2E_ROOTS = ['apps/web/e2e', 'apps/desktop/e2e'];
const TOOL_CATEGORY_SOURCE = readFileSync(
  path.join(REPO_ROOT, 'packages/assistant-contract/src/tool-categories.ts'),
  'utf8'
);
const TOOL_CATEGORY_BLOCK = /\bTOOL_CATEGORIES\s*:[^=]+?=\s*\{([\s\S]*?)\n\};/.exec(
  TOOL_CATEGORY_SOURCE
)?.[1];
assert.ok(TOOL_CATEGORY_BLOCK, 'must locate TOOL_CATEGORIES in the canonical contract source');
const FORBIDDEN_CATEGORY_LABELS = new Set(
  [...TOOL_CATEGORY_BLOCK.matchAll(/\blabel\s*:\s*['"]([^'"]+)['"]/g)].map((match) => match[1])
);
assert.ok(FORBIDDEN_CATEGORY_LABELS.size > 0, 'must discover category presentation labels');

function hardcodedCategoryLabels(source) {
  const sourceFile = ts.createSourceFile(
    'category-filter.test.ts',
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS
  );
  const labels = [];

  function visit(node) {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      FORBIDDEN_CATEGORY_LABELS.has(node.text)
    ) {
      labels.push(node.text);
    } else if (ts.isRegularExpressionLiteral(node)) {
      for (const label of FORBIDDEN_CATEGORY_LABELS) {
        if (node.text.includes(label)) {
          labels.push(label);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return labels;
}

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

function isWithinE2eRoot(relativePath, root) {
  const normalizedPath = relativePath.replaceAll('\\', '/');
  const normalizedRoot = root.replaceAll('\\', '/');
  return normalizedPath.startsWith(`${normalizedRoot}/`);
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
    !/\bconst\s+TOOL_CATEGORY_LABEL\s*=\s*TOOL_CATEGORIES\s*\[\s*NATIVE_TOOL_DEFAULTS\s*\[\s*NATIVE_TOOL_ID\s*\]\s*\.category\s*\]\s*\.label\s*;/.test(
      source
    )
  ) {
    violations.push('does not derive the category label from the native-tool contract');
  }
  if (
    !/getByRole\(\s*['"]option['"]\s*,\s*\{(?=[^}]*\bexact:\s*true\b)(?=[^}]*\bname:\s*TOOL_CATEGORY_LABEL\b)[^}]*\}\s*\)/.test(
      source
    )
  ) {
    violations.push(
      'does not select the category option through exact TOOL_CATEGORY_LABEL matching'
    );
  }
  if (hardcodedCategoryLabels(source).length > 0) {
    violations.push('hardcodes an option presentation label');
  }

  return violations;
}

for (const hardcodedName of ["'Analysis'", '/Retrieval/']) {
  test(`MONEY TEST: a derived selector cannot hide hardcoded ${hardcodedName}`, () => {
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
    await page.getByRole('option', { exact: true, name: ${hardcodedName} }).click();
  `;

    assert.deepEqual(categoryLabelViolations(source), ['hardcodes an option presentation label']);
  });
}

test('MONEY TEST: the metadata-derived option selector must retain exact matching', () => {
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
      { exact: false, name: TOOL_CATEGORY_LABEL }
    ).click();
  `;

  assert.deepEqual(categoryLabelViolations(source), [
    'does not select the category option through exact TOOL_CATEGORY_LABEL matching',
  ]);
});

test('MONEY TEST: an unused metadata expression cannot hide a hardcoded label initializer', () => {
  const source = `
    import {
      NATIVE_TOOL_DEFAULTS,
      TOOL_CATEGORIES,
    } from '@brainstrike/assistant-contract/tool-metadata';
    const NATIVE_TOOL_ID = 'brainstrike.readWorkspaceContext';
    const UNUSED_DERIVED_LABEL = TOOL_CATEGORIES[
      NATIVE_TOOL_DEFAULTS[NATIVE_TOOL_ID].category
    ].label;
    const TOOL_CATEGORY_LABEL = 'Retrieval';
    await page.getByRole(
      'option',
      { exact: true, name: TOOL_CATEGORY_LABEL }
    ).click();
  `;

  assert.deepEqual(categoryLabelViolations(source), [
    'does not derive the category label from the native-tool contract',
    'hardcodes an option presentation label',
  ]);
});

test('MONEY TEST: a hardcoded label alias cannot bypass the selector guard', () => {
  const source = `
    import {
      NATIVE_TOOL_DEFAULTS,
      TOOL_CATEGORIES,
    } from '@brainstrike/assistant-contract/tool-metadata';
    const NATIVE_TOOL_ID = 'brainstrike.readWorkspaceContext';
    const TOOL_CATEGORY_LABEL = TOOL_CATEGORIES[
      NATIVE_TOOL_DEFAULTS[NATIVE_TOOL_ID].category
    ].label;
    const STALE_CATEGORY_LABEL = 'Analysis';
    await page.getByRole('option', { exact: true, name: TOOL_CATEGORY_LABEL }).click();
    await page.getByRole('option', { exact: true, name: STALE_CATEGORY_LABEL }).click();
  `;

  assert.deepEqual(categoryLabelViolations(source), ['hardcodes an option presentation label']);
});

test('MONEY TEST: a hardcoded fallback cannot bypass the derived initializer guard', () => {
  const source = `
    import {
      NATIVE_TOOL_DEFAULTS,
      TOOL_CATEGORIES,
    } from '@brainstrike/assistant-contract/tool-metadata';
    const NATIVE_TOOL_ID = 'brainstrike.readWorkspaceContext';
    const TOOL_CATEGORY_LABEL = TOOL_CATEGORIES[
      NATIVE_TOOL_DEFAULTS[NATIVE_TOOL_ID].category
    ].label ?? 'Retrieval';
    await page.getByRole('option', { exact: true, name: TOOL_CATEGORY_LABEL }).click();
  `;

  assert.deepEqual(categoryLabelViolations(source), [
    'does not derive the category label from the native-tool contract',
    'hardcodes an option presentation label',
  ]);
});

test('discovers a readWorkspaceContext category-filter spec in every E2E root', () => {
  for (const root of E2E_ROOTS) {
    assert.ok(
      AI_TOOLS_SPECS.some((relativePath) => isWithinE2eRoot(relativePath, root)),
      `expected a readWorkspaceContext category-filter spec under ${root}`
    );
  }
});

test('MONEY TEST: Windows-style discovered paths remain attributable to E2E roots', () => {
  assert.equal(isWithinE2eRoot('apps\\web\\e2e\\settings-tools.test.ts', 'apps/web/e2e'), true);
});

for (const relativePath of AI_TOOLS_SPECS) {
  test(`REAL REPO: ${relativePath} derives its category label from tool metadata`, () => {
    const source = readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
    assert.deepEqual(categoryLabelViolations(source), []);
  });
}
