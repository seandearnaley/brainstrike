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

function analyzeOptionSelectors(source) {
  const sourceFile = ts.createSourceFile(
    'category-filter.test.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const declarationsByScope = new Map();
  const hardcodedLabels = [];
  let hasExactDerivedSelector = false;

  function enclosingScope(node) {
    for (let current = node; current; current = current.parent) {
      if (ts.isSourceFile(current) || ts.isBlock(current) || ts.isCaseBlock(current)) {
        return current;
      }
    }
    return;
  }

  function collectVariableDeclarations(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const scope = enclosingScope(node.parent);
      if (scope) {
        const declarations = declarationsByScope.get(scope) ?? new Map();
        const namedDeclarations = declarations.get(node.name.text) ?? [];
        namedDeclarations.push(node);
        declarations.set(node.name.text, namedDeclarations);
        declarationsByScope.set(scope, declarations);
      }
    }
    ts.forEachChild(node, collectVariableDeclarations);
  }

  function resolveIdentifier(identifier) {
    for (let scope = enclosingScope(identifier); scope; scope = enclosingScope(scope.parent)) {
      const declaration = declarationsByScope
        .get(scope)
        ?.get(identifier.text)
        ?.findLast((candidate) => candidate.pos < identifier.pos);
      if (declaration) {
        return declaration;
      }
    }
    return;
  }

  function collectLabels(node, resolvingDeclarations = new Set()) {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      FORBIDDEN_CATEGORY_LABELS.has(node.text)
    ) {
      hardcodedLabels.push(node.text);
    } else if (ts.isRegularExpressionLiteral(node)) {
      const closingSlash = node.text.lastIndexOf('/');
      const pattern = node.text.slice(1, closingSlash);
      const flags = node.text.slice(closingSlash + 1);
      for (const label of FORBIDDEN_CATEGORY_LABELS) {
        if (
          flags.includes('i')
            ? pattern.toLocaleLowerCase('en-US').includes(label.toLocaleLowerCase('en-US'))
            : pattern.includes(label)
        ) {
          hardcodedLabels.push(label);
        }
      }
    } else if (ts.isIdentifier(node)) {
      const declaration = resolveIdentifier(node);
      if (declaration?.initializer && !resolvingDeclarations.has(declaration)) {
        const nextResolvingDeclarations = new Set(resolvingDeclarations);
        nextResolvingDeclarations.add(declaration);
        collectLabels(declaration.initializer, nextResolvingDeclarations);
      }
      return;
    }
    ts.forEachChild(node, (child) => collectLabels(child, resolvingDeclarations));
  }

  function propertyValue(object, name) {
    const property = object.properties.find(
      (property) =>
        (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
        ((ts.isIdentifier(property.name) && property.name.text === name) ||
          (ts.isStringLiteral(property.name) && property.name.text === name))
    );
    if (property && ts.isPropertyAssignment(property)) {
      return property.initializer;
    }
    if (property && ts.isShorthandPropertyAssignment(property)) {
      return property.name;
    }
    return;
  }

  function inspectOptionSelectors(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'getByRole' &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === 'option' &&
      node.arguments[1] &&
      ts.isObjectLiteralExpression(node.arguments[1])
    ) {
      const nameValue = propertyValue(node.arguments[1], 'name');
      const exactValue = propertyValue(node.arguments[1], 'exact');
      if (nameValue) {
        collectLabels(nameValue);
        if (
          ts.isIdentifier(nameValue) &&
          nameValue.text === 'TOOL_CATEGORY_LABEL' &&
          exactValue?.kind === ts.SyntaxKind.TrueKeyword
        ) {
          hasExactDerivedSelector = true;
        }
      }
    }
    ts.forEachChild(node, inspectOptionSelectors);
  }

  collectVariableDeclarations(sourceFile);
  inspectOptionSelectors(sourceFile);
  return { hardcodedLabels, hasExactDerivedSelector };
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
  const selectorAnalysis = analyzeOptionSelectors(source);

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
  if (!selectorAnalysis.hasExactDerivedSelector) {
    violations.push(
      'does not select the category option through exact TOOL_CATEGORY_LABEL matching'
    );
  }
  if (selectorAnalysis.hardcodedLabels.length > 0) {
    violations.push('hardcodes an option presentation label');
  }

  return violations;
}

for (const hardcodedName of ["'Analysis'", '/retrieval/i']) {
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
      { exact: false /* exact: true */, name: TOOL_CATEGORY_LABEL }
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

test('MONEY TEST: a shorthand hardcoded name cannot bypass the selector guard', () => {
  const source = `
    import {
      NATIVE_TOOL_DEFAULTS,
      TOOL_CATEGORIES,
    } from '@brainstrike/assistant-contract/tool-metadata';
    const NATIVE_TOOL_ID = 'brainstrike.readWorkspaceContext';
    const TOOL_CATEGORY_LABEL = TOOL_CATEGORIES[
      NATIVE_TOOL_DEFAULTS[NATIVE_TOOL_ID].category
    ].label;
    await page.getByRole('option', { exact: true, name: TOOL_CATEGORY_LABEL }).click();
    const name = 'Retrieval';
    await page.getByRole('option', { exact: true, name }).click();
  `;

  assert.deepEqual(categoryLabelViolations(source), ['hardcodes an option presentation label']);
});

test('MONEY TEST: same-named aliases resolve through their lexical scopes', () => {
  const source = `
    import {
      NATIVE_TOOL_DEFAULTS,
      TOOL_CATEGORIES,
    } from '@brainstrike/assistant-contract/tool-metadata';
    const NATIVE_TOOL_ID = 'brainstrike.readWorkspaceContext';
    const TOOL_CATEGORY_LABEL = TOOL_CATEGORIES[
      NATIVE_TOOL_DEFAULTS[NATIVE_TOOL_ID].category
    ].label;
    await page.getByRole('option', { exact: true, name: TOOL_CATEGORY_LABEL }).click();
    test('hardcoded scope', async () => {
      const label = 'Analysis';
      await page.getByRole('option', { exact: true, name: label }).click();
    });
    test('derived scope', async () => {
      const label = TOOL_CATEGORY_LABEL;
      await page.getByRole('option', { exact: true, name: label }).click();
    });
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

test('MONEY TEST: unrelated category words do not trigger selector violations', () => {
  const source = `
    import {
      NATIVE_TOOL_DEFAULTS,
      TOOL_CATEGORIES,
    } from '@brainstrike/assistant-contract/tool-metadata';
    const NATIVE_TOOL_ID = 'brainstrike.readWorkspaceContext';
    const TOOL_CATEGORY_LABEL = TOOL_CATEGORIES[
      NATIVE_TOOL_DEFAULTS[NATIVE_TOOL_ID].category
    ].label;
    test('Analysis remains available as unrelated fixture data', async () => {
      await page.getByRole('option', { exact: true, name: TOOL_CATEGORY_LABEL }).click();
    });
  `;

  assert.deepEqual(categoryLabelViolations(source), []);
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
