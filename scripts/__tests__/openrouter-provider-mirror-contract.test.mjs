import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The strict-content gateway uses the native V4 provider through Mastra's
// public gateway interface; Mastra's other OpenRouter models use its vendored
// reference. The strict-content spec proves wire equivalence while preserving
// the Qwen-only content normalization. No declaration cast joins the lineages.
// Keep BOTH exact lineages explicit: changing either requires rerunning the
// strict-content wire-equivalence and host usage/file/approval receipts.
const QUALIFIED = { mastra: '1.71.0', strictContent: '3.1.0', vendored: '2.10.0' };
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

test('both provider lineages match the explicitly qualified gateway pair', () => {
  const [vendoredVersion] = [...readMastraVendoredVersions()];
  const require = createRequire(path.join(repoRoot, 'packages/agent/package.json'));
  const mastra = JSON.parse(readFileSync(require.resolve('@mastra/core/package.json'), 'utf8'));
  assert.deepEqual(
    { mastra: mastra.version, strictContent: readCatalogPin(), vendored: vendoredVersion },
    QUALIFIED,
    'Re-qualify strict-content wire equivalence and host receipts before changing either lineage.'
  );
});

test('the installed npm provider matches the catalog pin', () => {
  assert.equal(readInstalledVersion(), readCatalogPin());
});

test('the installed strict-content provider exposes V4 through ESM and Node CJS interop', async () => {
  const require = createRequire(path.join(repoRoot, 'packages/agent/package.json'));
  const providerPath = require.resolve('@openrouter/ai-sdk-provider');
  const providers = [require(providerPath), await import(pathToFileURL(providerPath).href)];
  for (const provider of providers) {
    const model = provider.createOpenRouter({ apiKey: 'offline-qualification' })(
      'qwen/qwen3.8-max'
    );
    assert.equal(model.specificationVersion, 'v4');
    assert.equal(typeof model.doGenerate, 'function');
    assert.equal(typeof model.doStream, 'function');
  }
});
