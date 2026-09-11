import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const agentRoot = path.join(repoRoot, 'packages', 'agent');
const agentManifest = JSON.parse(readFileSync(path.join(agentRoot, 'package.json'), 'utf8'));
const agentTsupConfig = readFileSync(path.join(agentRoot, 'tsup.config.ts'), 'utf8');

test('agent declarations are emitted by tsc before the JavaScript bundle', () => {
  // prune-stale-dist runs first (stale-dist cache-poisoning guard — see
  // scripts/__tests__/prune-stale-dist.test.mjs); the ordering this contract
  // exists for is tsc BEFORE tsup, which the prune step does not disturb.
  assert.equal(
    agentManifest.scripts.build,
    'node ../../scripts/prune-stale-dist.mjs && tsc -b . && tsup && node scripts/verify-hosted-web-bundle.mjs'
  );
  assert.match(
    agentTsupConfig,
    /const sharedConfig = \{[\s\S]*?\bdts: false,/,
    'every agent tsup build must inherit dts: false from sharedConfig'
  );
  assert.equal(
    [...agentTsupConfig.matchAll(/\.\.\.sharedConfig,/g)].length,
    2,
    'both the broad and Hosted Web build configs must inherit sharedConfig'
  );
  assert.doesNotMatch(
    agentTsupConfig,
    /\bdts:\s*\{/,
    'tsup must not start its declaration-bundler worker for any agent entry'
  );
});

test('agent development watches declarations and JavaScript as sibling processes', () => {
  assert.equal(
    agentManifest.scripts.dev,
    'concurrently --kill-others --names types,bundle "tsc --project tsconfig.json --watch --preserveWatchOutput" "tsup --watch"'
  );
  // concurrently is governed by the pnpm catalog now (BST-748): a single
  // source of truth in pnpm-workspace.yaml (^10.0.3), enforced everywhere by
  // verify-catalog-references.mjs + catalogMode: strict. The build contract
  // still requires agent to declare it DIRECTLY — now via the `catalog:`
  // protocol rather than a hand-synced literal.
  assert.equal(
    agentManifest.devDependencies.concurrently,
    'catalog:',
    'the package that invokes concurrently must declare it directly (via the catalog)'
  );
});

// The deployed loader disables require(ESM). The actual generated status/POST
// routes are qualified with that flag; retain the consumer's ESM selection.
test('hosted functions select native ESM library exports', () => {
  const webManifest = JSON.parse(
    readFileSync(path.join(repoRoot, 'apps/web/package.json'), 'utf8')
  );
  assert.equal(webManifest.type, 'module');
});
