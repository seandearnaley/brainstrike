import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// BST-1361: `packages/indexing-contract` deliberately depends only on
// `@brainstrike/logging` + `@brainstrike/types`, so its embedding-provider
// definitions cannot import the canonical env-name scheme from
// `@brainstrike/assistant-contract`'s provider registry. This contract closes
// the drift gap the dependency direction forbids closing with an import:
//
//  - every registry-keyed provider mirrored in indexing-contract must carry
//    EXACTLY the registry's canonical envKeys (BRAINSTRIKE_* override first,
//    vendor-standard name second);
//  - no registry `deprecatedEnvKeys` name may appear in any indexing-contract
//    resolution list (a deprecated var must never authenticate);
//  - `NO_API_KEY_HOSTED_PROVIDERS` must equal the registry's
//    `authType: 'none'` providers restricted to indexing-contract's hosted
//    union (keyless-ness derives from authType — never a hand list, BST-1349).

const REGISTRY_PATH = path.join(repoRoot, 'packages/assistant-contract/src/provider-registry.ts');
const INDEXING_PATH = path.join(repoRoot, 'packages/indexing-contract/src/index.ts');

function parseSource(filePath) {
  return ts.createSourceFile(
    path.basename(filePath),
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

function findVariableInitializer(sourceFile, variableName) {
  let initializer;
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName &&
      node.initializer
    ) {
      initializer = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.ok(initializer, `${sourceFile.fileName} must declare ${variableName}`);
  return initializer;
}

function unwrapExpression(node) {
  let current = node;
  while (ts.isAsExpression(current) || ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function readStringArray(node, context) {
  const arrayNode = unwrapExpression(node);
  assert.ok(ts.isArrayLiteralExpression(arrayNode), `${context} must be a static array literal`);
  return arrayNode.elements.map((element) => {
    assert.ok(ts.isStringLiteralLike(element), `${context} entries must be string literals`);
    return element.text;
  });
}

function readProviderTable(sourceFile, variableName, fields) {
  const initializer = unwrapExpression(findVariableInitializer(sourceFile, variableName));
  assert.ok(
    ts.isArrayLiteralExpression(initializer),
    `${variableName} must be a static array literal`
  );
  const providers = new Map();
  for (const element of initializer.elements) {
    assert.ok(ts.isObjectLiteralExpression(element), `${variableName} entries must be objects`);
    const entry = {};
    for (const property of element.properties) {
      if (!(ts.isPropertyAssignment(property) && ts.isIdentifier(property.name))) {
        continue;
      }
      const name = property.name.text;
      if (name === 'id' || name === 'authType' || name === 'runtime') {
        assert.ok(
          ts.isStringLiteralLike(property.initializer),
          `${variableName} ${name} must be a string literal`
        );
        entry[name] = property.initializer.text;
      } else if (fields.includes(name)) {
        entry[name] = readStringArray(property.initializer, `${variableName} ${name}`);
      }
    }
    assert.ok(entry.id, `${variableName} entry is missing a literal id`);
    providers.set(entry.id, entry);
  }
  return providers;
}

function readRegistryProviders() {
  return readProviderTable(parseSource(REGISTRY_PATH), 'PROVIDER_DEFINITIONS', [
    'envKeys',
    'deprecatedEnvKeys',
  ]);
}

function readIndexingProviders() {
  return readProviderTable(parseSource(INDEXING_PATH), 'EMBEDDING_PROVIDER_DEFINITIONS', [
    'envKeys',
  ]);
}

function readNoApiKeySet() {
  const sourceFile = parseSource(INDEXING_PATH);
  const initializer = unwrapExpression(
    findVariableInitializer(sourceFile, 'NO_API_KEY_HOSTED_PROVIDERS')
  );
  assert.ok(
    ts.isNewExpression(initializer) && initializer.arguments?.length === 1,
    'NO_API_KEY_HOSTED_PROVIDERS must be constructed from a static array'
  );
  return readStringArray(initializer.arguments[0], 'NO_API_KEY_HOSTED_PROVIDERS');
}

test('indexing-contract envKeys mirror the registry canonical scheme exactly', () => {
  const registry = readRegistryProviders();
  const indexing = readIndexingProviders();
  const mirrored = [...indexing.values()].filter(
    (provider) => registry.has(provider.id) && (registry.get(provider.id).envKeys ?? []).length > 0
  );
  assert.ok(
    mirrored.length >= 4,
    'expected indexing-contract to mirror at least openai/google/cohere/voyage'
  );
  for (const provider of mirrored) {
    assert.deepEqual(
      provider.envKeys ?? [],
      registry.get(provider.id).envKeys,
      `indexing-contract envKeys for ${provider.id} drifted from the provider registry — ` +
        'update packages/indexing-contract/src/index.ts to the canonical two-name scheme'
    );
  }
});

test('no deprecated registry name appears in any indexing-contract resolution list', () => {
  const registry = readRegistryProviders();
  const deprecatedNames = new Set(
    [...registry.values()].flatMap((provider) => provider.deprecatedEnvKeys ?? [])
  );
  assert.ok(deprecatedNames.size > 0, 'registry must declare deprecatedEnvKeys (BST-1361)');
  for (const provider of readIndexingProviders().values()) {
    for (const name of provider.envKeys ?? []) {
      assert.ok(
        !deprecatedNames.has(name),
        `indexing-contract lists deprecated env name ${name} for ${provider.id}; ` +
          'deprecated names must never authenticate'
      );
    }
  }
});

test('NO_API_KEY_HOSTED_PROVIDERS equals the registry authType:none hosted providers', () => {
  const registry = readRegistryProviders();
  // Restrict to indexing-contract's HOSTED union: its `local`/`transformers`
  // providers are LocalProviderType, outside NO_API_KEY_HOSTED_PROVIDERS'
  // HostedProviderType domain.
  const hostedIndexingIds = new Set(
    [...readIndexingProviders().values()]
      .filter((provider) => provider.runtime === 'hosted')
      .map((provider) => provider.id)
  );
  const expected = [...registry.values()]
    .filter((provider) => provider.authType === 'none' && hostedIndexingIds.has(provider.id))
    .map((provider) => provider.id)
    .sort();
  assert.deepEqual(readNoApiKeySet().slice().sort(), expected);
});
