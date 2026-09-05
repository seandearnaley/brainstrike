import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = parseYaml(readFileSync(path.join(repoRoot, '.github/workflows/test.yml'), 'utf8'));
const playwrightConfig = readFileSync(
  path.join(repoRoot, 'apps/desktop/playwright.config.mts'),
  'utf8'
);

test('required desktop smoke uploads the directory where Playwright writes failure traces', () => {
  const steps = workflow.jobs['desktop-e2e'].steps;
  const smokeIndex = steps.findIndex((step) => step.name === 'Run desktop smoke');
  const uploadIndex = steps.findIndex((step) => step.name === 'Upload desktop smoke traces');
  assert.ok(smokeIndex >= 0 && uploadIndex > smokeIndex);
  const upload = steps[uploadIndex];
  assert.equal(upload.if, 'failure()');
  assert.match(upload.uses, /^actions\/upload-artifact@/u);

  // BST-1639 produced a trace here, but the uploader looked in test-results
  // and silently uploaded nothing. Pin the observed output boundary on both
  // sides so a config edit cannot strand the evidence again.
  assert.match(playwrightConfig, /outputDir:\s*'blob-report\/'/u);
  assert.equal(upload.with.path, 'apps/desktop/blob-report/');
  assert.equal(upload.with['if-no-files-found'], 'warn');
});
