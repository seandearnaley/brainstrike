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
  assert.equal(
    agentManifest.scripts.build,
    'tsc -b . && tsup && node scripts/verify-hosted-web-bundle.mjs'
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
  assert.equal(
    agentManifest.devDependencies.concurrently,
    '^10.0.3',
    'the package that invokes concurrently must declare it directly'
  );
});
