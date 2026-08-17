import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// PR #2501: `packages/agent/src/providers/openrouter-strict-content.ts`
// resolves OpenRouter strict-content models (qwen/*) through the npm
// `@openrouter/ai-sdk-provider` package, on the stated premise that it is THE
// EXACT version `@mastra/core` bundles for its own openrouter resolution —
// that premise is what makes the request-equivalence spec meaningful and the
// `as unknown as GatewayLanguageModel` cast safe. Nothing ties the two
// together: `@mastra/core` vendors its copy inside its dist (no dependency
// edge in the lockfile), and the workspace catalog pin is a hand-maintained
// mirror of it. Either side can move alone — a `@mastra/core` bump changes the
// vendored converter with the pin unchanged, and a pin bump diverges from
// Mastra — with no type error, because the cast erases the lineage.
//
// This contract closes the loop: the version path baked into the bundled
// chunk's `//#region` provenance comments must match both the workspace
// catalog pin and the installed npm package. On mismatch, re-verify the
// strict-content gateway against the new vendored copy (the equivalence spec
// in `packages/agent/src/__tests__/openrouter-strict-content.spec.ts` is the
// behavioral check), then move the pin.
const VENDORED_PATH_PATTERN = /@openrouter\/ai-sdk-provider\/(\d+\.\d+\.\d+(?:-[\w.]+)?)\//g;

function readMastraVendoredVersions() {
  const require = createRequire(path.join(repoRoot, 'packages/agent/package.json'));
  const mastraPackageJson = require.resolve('@mastra/core/package.json');
  const distDir = path.join(path.dirname(mastraPackageJson), 'dist');
  const versions = new Set();
  for (const entry of readdirSync(distDir)) {
    if (!(entry.endsWith('.js') || entry.endsWith('.cjs'))) {
      continue;
    }
    const source = readFileSync(path.join(distDir, entry), 'utf8');
    for (const match of source.matchAll(VENDORED_PATH_PATTERN)) {
      versions.add(match[1]);
    }
  }
  return versions;
}

function readCatalogPin() {
  const workspaceYaml = readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
  const match = workspaceYaml.match(/'@openrouter\/ai-sdk-provider':\s*(\S+)/);
  assert.ok(match, 'pnpm-workspace.yaml must pin @openrouter/ai-sdk-provider in the catalog');
  return match[1];
}

function readInstalledVersion() {
  const require = createRequire(path.join(repoRoot, 'packages/agent/package.json'));
  const providerPackageJson = require.resolve('@openrouter/ai-sdk-provider/package.json');
  return JSON.parse(readFileSync(providerPackageJson, 'utf8')).version;
}

test('@mastra/core vendors exactly one @openrouter/ai-sdk-provider version', () => {
  const vendored = readMastraVendoredVersions();
  assert.ok(
    vendored.size >= 1,
    '@mastra/core dist no longer carries @openrouter/ai-sdk-provider provenance paths; ' +
      'the vendored-version extraction in this contract needs a new detection strategy ' +
      'before the strict-content gateway premise can be trusted.'
  );
  assert.equal(
    vendored.size,
    1,
    `@mastra/core dist references multiple vendored provider versions: ${[...vendored].join(', ')}`
  );
});

test('the workspace catalog pin matches the version @mastra/core bundles', () => {
  const [vendoredVersion] = [...readMastraVendoredVersions()];
  const catalogPin = readCatalogPin();
  assert.equal(
    catalogPin,
    vendoredVersion,
    `The @openrouter/ai-sdk-provider catalog pin (${catalogPin}) has diverged from the version ` +
      `@mastra/core bundles (${vendoredVersion}). Re-verify the strict-content gateway against the ` +
      'new vendored copy (openrouter-strict-content.spec.ts equivalence test), then move the pin.'
  );
});

test('the installed npm provider matches the catalog pin', () => {
  assert.equal(readInstalledVersion(), readCatalogPin());
});
