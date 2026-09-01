import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readRepoFile = (relativePath) => readFileSync(path.join(repoRoot, relativePath), 'utf8');
const packagedCommand =
  'dbus-run-session -- pnpm --filter @brainstrike/desktop run test:e2e:lane:packaged-mcp-apps';

test('the native package job runs the MCP Apps verifier against the package it just built', () => {
  const workflow = parseYaml(readRepoFile('.github/workflows/test.yml'));
  const steps = workflow.jobs['native-electron'].steps;
  const packageIndex = steps.findIndex((step) => step.name === 'Package the desktop application');
  const verifierIndex = steps.findIndex(
    (step) => step.name === 'Verify packaged MCP Apps lifecycle'
  );
  const nativeIndex = steps.findIndex(
    (step) => step.name === 'Load the packaged native capability in Electron'
  );

  assert.notEqual(packageIndex, -1);
  assert.notEqual(verifierIndex, -1);
  assert.notEqual(nativeIndex, -1);
  assert.ok(packageIndex < verifierIndex);
  assert.ok(verifierIndex < nativeIndex);
  assert.equal(steps[verifierIndex].run, packagedCommand);
  assert.equal(steps[verifierIndex]['continue-on-error'], undefined);
});

test('the packaged-only spec has one explicit lane and is absent from unpackaged regression', () => {
  const desktopPackage = JSON.parse(readRepoFile('apps/desktop/package.json'));
  const packagedScript = desktopPackage.scripts['test:e2e:lane:packaged-mcp-apps'];
  assert.match(packagedScript, /mcp-apps-production-lifecycle\.desktop\.test\.ts/u);
  assert.match(packagedScript, /--project=regression/u);
  assert.match(packagedScript, /--workers=1/u);
  assert.match(packagedScript, /--retries=0/u);
  assert.match(packagedScript, /--global-timeout=360000/u);
  assert.match(desktopPackage.scripts['test:e2e:lane:full-regression'], /@packaged/u);

  const verifier = readRepoFile('apps/desktop/e2e/mcp-apps-production-lifecycle.desktop.test.ts');
  assert.match(verifier, /tag:\s*\['@destructive',\s*'@packaged'\]/u);
  assert.match(verifier, /McpUiInitializeResultSchema/u);
  assert.match(verifier, /installMcpAppElectronSandboxPolicy/u);
  assert.match(verifier, /new App\(/u);
});

test('the living CI and provider contracts name the packaged Apps lane', () => {
  for (const contract of [
    readRepoFile('docs/agents/assistant-providers.md'),
    readRepoFile('docs/agents/ci-quality.md'),
  ]) {
    assert.match(contract, /test:e2e:lane:packaged-mcp-apps/u);
    assert.match(contract, /Native Electron Package/u);
  }
});
