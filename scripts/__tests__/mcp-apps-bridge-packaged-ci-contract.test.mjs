import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readRepoFile = (relativePath) => readFileSync(path.join(repoRoot, relativePath), 'utf8');
const packagedCommand =
  'dbus-run-session -- pnpm --filter @brainstrike/desktop run test:e2e:lane:packaged-mcp-apps-bridge';

test('the native package job runs the Apps bridge verifier against the package it just built', () => {
  const workflow = parseYaml(readRepoFile('.github/workflows/test.yml'));
  const steps = workflow.jobs['native-electron'].steps;
  const packageIndex = steps.findIndex((step) => step.name === 'Package the desktop application');
  const verifierIndex = steps.findIndex((step) => step.name === 'Verify packaged MCP Apps bridge');
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
  // The verifier imports the built bridge module; the job must build it.
  const dependencyBuild = steps.find((step) => step.name === 'Build desktop dependency graph');
  assert.match(String(dependencyBuild?.run), /--filter=@brainstrike\/mcp-app-host/u);
});

test('the packaged-only bridge spec has one explicit lane and is absent from unpackaged regression', () => {
  const desktopPackage = JSON.parse(readRepoFile('apps/desktop/package.json'));
  const packagedScript = desktopPackage.scripts['test:e2e:lane:packaged-mcp-apps-bridge'];
  assert.match(packagedScript, /mcp-apps-bridge\.desktop\.test\.ts/u);
  assert.match(packagedScript, /--project=regression/u);
  assert.match(packagedScript, /--workers=1/u);
  assert.match(packagedScript, /--retries=0/u);
  assert.match(desktopPackage.scripts['test:e2e:lane:full-regression'], /@packaged/u);

  const verifier = readRepoFile('apps/desktop/e2e/mcp-apps-bridge.desktop.test.ts');
  assert.match(verifier, /tag:\s*\['@destructive',\s*'@packaged'\]/u);
  assert.match(verifier, /constants\.X_OK/u);
  // The harness must never be written into a published dist/ directory.
  assert.doesNotMatch(verifier, /path\.dirname\(bridgeModulePath\)/u);
});

test('the living CI and provider contracts name the packaged Apps bridge lane', () => {
  for (const contract of [
    readRepoFile('docs/agents/assistant-providers.md'),
    readRepoFile('docs/agents/ci-quality.md'),
  ]) {
    assert.match(contract, /test:e2e:lane:packaged-mcp-apps-bridge/u);
  }
});
