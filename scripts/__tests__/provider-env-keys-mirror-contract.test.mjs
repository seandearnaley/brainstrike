import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  findVariableInitializer,
  parseTypeScriptSource,
  readProviderTable,
  readStringArray,
  unwrapExpression,
} from '../provider-registry-ast-helpers.mjs';

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

function parseFile(filePath) {
  return parseTypeScriptSource(readFileSync(filePath, 'utf8'), path.basename(filePath));
}

function failOnProblem(message) {
  assert.fail(message);
}

function readRegistryProviders() {
  return readProviderTable(
    parseFile(REGISTRY_PATH),
    'PROVIDER_DEFINITIONS',
    ['envKeys', 'deprecatedEnvKeys'],
    failOnProblem
  );
}

function readIndexingProviders() {
  return readProviderTable(
    parseFile(INDEXING_PATH),
    'EMBEDDING_PROVIDER_DEFINITIONS',
    ['envKeys'],
    failOnProblem
  );
}

function readNoApiKeySet() {
  const sourceFile = parseFile(INDEXING_PATH);
  const declaration = findVariableInitializer(sourceFile, 'NO_API_KEY_HOSTED_PROVIDERS');
  assert.ok(declaration, 'indexing-contract must declare NO_API_KEY_HOSTED_PROVIDERS');
  const initializer = unwrapExpression(declaration);
  assert.ok(
    ts.isNewExpression(initializer) && initializer.arguments?.length === 1,
    'NO_API_KEY_HOSTED_PROVIDERS must be constructed from a static array'
  );
  return readStringArray(initializer.arguments[0], 'NO_API_KEY_HOSTED_PROVIDERS', failOnProblem);
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
