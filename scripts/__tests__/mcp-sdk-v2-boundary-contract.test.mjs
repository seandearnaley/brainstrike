import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourceRoots = ['apps/desktop/src', 'packages/agent/src'];
const sourceExtensions = new Set(['.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);
const productionSdkPackages = ['@modelcontextprotocol/client'];
const testSdkPackages = [
  '@modelcontextprotocol/node',
  '@modelcontextprotocol/server',
  '@modelcontextprotocol/server-legacy',
];

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function sourceFiles(relativeDirectory) {
  const directory = path.join(repoRoot, relativeDirectory);
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && sourceExtensions.has(path.extname(entry.name)))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

test('BST-1497: Brainstrike source and manifests use only stable SDK v2 split packages', () => {
  const v1References = sourceRoots.flatMap((root) =>
    sourceFiles(root)
      .filter((file) => readFileSync(file, 'utf8').includes('@modelcontextprotocol/sdk'))
      .map((file) => path.relative(repoRoot, file))
  );
  assert.deepEqual(
    v1References,
    [],
    `direct SDK v1 references remain:\n${v1References.join('\n')}`
  );

  for (const manifestPath of ['apps/desktop/package.json', 'packages/agent/package.json']) {
    const manifest = readJson(manifestPath);
    const declared = { ...manifest.dependencies, ...manifest.devDependencies };
    assert.equal(
      declared['@modelcontextprotocol/sdk'],
      undefined,
      `${manifestPath} retains SDK v1`
    );
    for (const packageName of productionSdkPackages) {
      assert.equal(
        manifest.dependencies[packageName],
        '2.0.0',
        `${manifestPath} must pin production package ${packageName} to the reviewed stable release`
      );
    }
    for (const packageName of testSdkPackages) {
      assert.equal(
        manifest.devDependencies[packageName],
        '2.0.0',
        `${manifestPath} must keep test package ${packageName} on the reviewed stable release`
      );
    }
  }

  const workspaceCatalog = readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
  assert.doesNotMatch(workspaceCatalog, /^\s*['"]?@modelcontextprotocol\/sdk['"]?:/m);
});

test('BST-1497: agent bundles externalize the complete SDK v2 package family', () => {
  const tsupConfig = readFileSync(path.join(repoRoot, 'packages/agent/tsup.config.ts'), 'utf8');
  const runtimeClient = readFileSync(
    path.join(repoRoot, 'packages/agent/src/mastra/mcp-runtime-client.ts'),
    'utf8'
  );
  const bundleVerifier = readFileSync(
    path.join(repoRoot, 'packages/agent/scripts/verify-hosted-web-bundle.mjs'),
    'utf8'
  );
  const providerContract = readFileSync(
    path.join(repoRoot, 'docs/agents/assistant-providers.md'),
    'utf8'
  );
  assert.match(tsupConfig, /modelContextProtocolV2External/);
  assert.match(tsupConfig, /\(\?:client\|core\|node\|server\|server-legacy\)/);
  assert.match(tsupConfig, /sharedExternal = \[\s*agentMcpClientExternal,/);
  assert.match(tsupConfig, /agentMcpClientExternal,[\s\S]*modelContextProtocolV2External,/);
  assert.doesNotMatch(tsupConfig, /modelContextProtocolSdkExternal/);
  assert.doesNotMatch(runtimeClient, /^\s*Explicit(?:Http|Stdio)McpClient,\s*$/m);
  assert.match(runtimeClient, /import\(\s*['"]@brainstrike\/agent\/mcp-client['"]\s*\)/);
  assert.match(bundleVerifier, /mcpFreeOutputs/);
  assert.match(bundleVerifier, /@modelcontextprotocol/);
  assert.match(providerContract, /Agent root,[\s\S]*contain no `@modelcontextprotocol\/\*`/);
});
