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
  assert.match(verifier, /new App\(/u);
  // The verifier mounts through the REAL main window: the production preload's
  // shell bridge, the production CSP stamp (blob: frames blocked), the packaged
  // brainstrike-mcp-app: shell protocol (404 once released), and the
  // will-frame-navigate fence. A harness window on a private partition would
  // escape the header stamp and hide exactly the regression class this guards.
  assert.match(verifier, /apps\.prepareShell/u);
  assert.match(verifier, /securitypolicyviolation/u);
  assert.match(verifier, /fetchStatusFromMain\(shellUrl\)\)\.toBe\(404\)/u);
  assert.match(verifier, /probeFrameFence/u);
  assert.doesNotMatch(verifier, /partition:\s*['`]/u);
  assert.doesNotMatch(verifier, /installMcpAppElectronSandboxPolicy/u);
  assert.doesNotMatch(verifier, /createObjectURL\(new Blob\(\[shell/u);
  const admissionHelper = readRepoFile('apps/desktop/e2e/helpers/mcp-apps-ordinary-admission.ts');
  assert.match(admissionHelper, /composeRuntimeToolMap/u);
  assert.match(admissionHelper, /createMcpAppOrdinaryToolCallPreparer/u);
  assert.doesNotMatch(verifier, /async function executeServerCall/u);
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
