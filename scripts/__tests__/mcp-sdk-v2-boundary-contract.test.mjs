import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sdkPackages = {
  dependencies: ['@modelcontextprotocol/client'],
  devDependencies: [
    '@modelcontextprotocol/node',
    '@modelcontextprotocol/server',
    '@modelcontextprotocol/server-legacy',
  ],
};

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

test('BST-1497: Brainstrike source and manifests use only stable SDK v2 split packages', () => {
  const v1References = globSync('{apps/desktop,packages/agent}/src/**/*.{js,jsx,mjs,mts,ts,tsx}', {
    cwd: repoRoot,
  }).filter((file) =>
    readFileSync(path.join(repoRoot, file), 'utf8').includes('@modelcontextprotocol/sdk')
  );
  assert.deepEqual(v1References, []);

  for (const manifestPath of ['apps/desktop/package.json', 'packages/agent/package.json']) {
    const manifest = readJson(manifestPath);
    const declared = { ...manifest.dependencies, ...manifest.devDependencies };
    assert.equal(declared['@modelcontextprotocol/sdk'], undefined);
    for (const [section, packageNames] of Object.entries(sdkPackages)) {
      for (const packageName of packageNames) {
        assert.equal(manifest[section][packageName], 'catalog:', `${manifestPath}: ${packageName}`);
      }
    }
  }

  const workspace = parse(readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'));
  assert.equal(workspace.catalog['@modelcontextprotocol/sdk'], undefined);
  for (const packageName of Object.values(sdkPackages).flat()) {
    assert.equal(workspace.catalog[packageName], '2.0.0');
  }
});

test('BST-1497: agent bundles externalize the complete SDK v2 package family', () => {
  const agentManifest = readJson('packages/agent/package.json');
  const bundleVerifier = readFileSync(
    path.join(repoRoot, 'packages/agent/scripts/verify-hosted-web-bundle.mjs'),
    'utf8'
  );
  assert.match(agentManifest.scripts.build, /verify-hosted-web-bundle\.mjs/);
  assert.match(bundleVerifier, /mcpFreeOutputs/);
  assert.match(bundleVerifier, /@modelcontextprotocol/);
});
