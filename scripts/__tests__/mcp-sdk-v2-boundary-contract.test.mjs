import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const clientPackage = '@modelcontextprotocol/client';
const serverTestPackages = [
  '@modelcontextprotocol/node',
  '@modelcontextprotocol/server',
  '@modelcontextprotocol/server-legacy',
];
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
    assert.equal(
      manifest.dependencies[clientPackage],
      'catalog:',
      `${manifestPath}: ${clientPackage}`
    );
  }

  const agentManifest = readJson('packages/agent/package.json');
  for (const packageName of serverTestPackages) {
    assert.equal(agentManifest.devDependencies[packageName], 'catalog:', packageName);
  }

  const desktopManifest = readJson('apps/desktop/package.json');
  const desktopDeclared = {
    ...desktopManifest.dependencies,
    ...desktopManifest.devDependencies,
  };
  for (const packageName of [...serverTestPackages, '@modelcontextprotocol/server-filesystem']) {
    assert.equal(desktopDeclared[packageName], undefined, packageName);
  }

  const workspace = parse(readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'));
  assert.equal(workspace.catalog['@modelcontextprotocol/sdk'], undefined);
  // GHSA-6qxp-vccf-f47h / CVE-2026-104850: 2.2.0 is the first patched client, so
  // this fence may only ever move forward within the patched line. `node` has no
  // 2.3.x release and peer-depends on `server` at ^2.3.0, hence the split.
  const expectedCatalogVersions = {
    [clientPackage]: '2.3.1',
    '@modelcontextprotocol/core': '2.3.1',
    '@modelcontextprotocol/node': '2.1.1',
    '@modelcontextprotocol/server': '2.3.1',
    '@modelcontextprotocol/server-legacy': '2.3.1',
  };
  for (const packageName of [clientPackage, '@modelcontextprotocol/core', ...serverTestPackages]) {
    assert.equal(workspace.catalog[packageName], expectedCatalogVersions[packageName], packageName);
  }
  assert.match(
    readJson('packages/agent/package.json').scripts.build,
    /verify-hosted-web-bundle\.mjs/
  );
});
