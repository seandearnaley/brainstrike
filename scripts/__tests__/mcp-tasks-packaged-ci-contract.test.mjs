import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readRepoFile = (relativePath) => readFileSync(path.join(repoRoot, relativePath), 'utf8');
const packagedCommand =
  'dbus-run-session -- pnpm --filter @brainstrike/desktop run test:e2e:lane:packaged-mcp-tasks';

test('the native package job bakes the Tasks harness and runs its verifier against that package', () => {
  const workflow = parseYaml(readRepoFile('.github/workflows/test.yml'));
  const steps = workflow.jobs['native-electron'].steps;
  const packageIndex = steps.findIndex((step) => step.name === 'Package the desktop application');
  const verifierIndex = steps.findIndex(
    (step) => step.name === 'Verify packaged MCP Tasks lifecycle'
  );
  const nativeIndex = steps.findIndex(
    (step) => step.name === 'Load the packaged native capability in Electron'
  );
  assert.notEqual(packageIndex, -1);
  assert.notEqual(verifierIndex, -1);
  assert.notEqual(nativeIndex, -1);
  assert.ok(packageIndex < verifierIndex);
  assert.ok(verifierIndex < nativeIndex);
  // The harness chunk exists only in a package built with the flag.
  assert.equal(steps[packageIndex].env?.VITE_MCP_TASK_HARNESS, '1');
  assert.equal(steps[verifierIndex].run, packagedCommand);
  assert.equal(steps[verifierIndex]['continue-on-error'], undefined);
});

test('the packaged-only Tasks spec has one explicit lane and is absent from unpackaged regression', () => {
  const desktopPackage = JSON.parse(readRepoFile('apps/desktop/package.json'));
  const packagedScript = desktopPackage.scripts['test:e2e:lane:packaged-mcp-tasks'];
  assert.match(packagedScript, /mcp-task-restart\.packaged\.desktop\.test\.ts/u);
  assert.match(packagedScript, /--project=regression/u);
  assert.match(packagedScript, /--workers=1/u);
  assert.match(packagedScript, /--retries=0/u);
  assert.match(desktopPackage.scripts['test:e2e:lane:full-regression'], /@packaged/u);

  const verifier = readRepoFile('apps/desktop/e2e/mcp-task-restart.packaged.desktop.test.ts');
  assert.match(verifier, /tag:\s*\['@destructive',\s*'@packaged'\]/u);
  assert.match(verifier, /constants\.X_OK/u);

  const lazyModule = readRepoFile(
    'apps/desktop/src/renderer/components/mcp-task-status-e2e-harness-lazy.tsx'
  );
  assert.match(lazyModule, /VITE_MCP_TASK_HARNESS/u);
});

test('the living CI and provider contracts name the packaged Tasks lane', () => {
  for (const contract of [
    readRepoFile('docs/agents/assistant-providers.md'),
    readRepoFile('docs/agents/ci-quality.md'),
  ]) {
    assert.match(contract, /test:e2e:lane:packaged-mcp-tasks/u);
  }
});
