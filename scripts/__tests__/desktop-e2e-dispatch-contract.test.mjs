import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflowPath = path.join(repoRoot, '.github/workflows/desktop-e2e.yml');
const embeddingSmokePath = path.join(
  repoRoot,
  'apps/desktop/e2e/embedding-worker-renderer.smoke.desktop.test.ts'
);
const embeddingFixturePath = path.join(
  repoRoot,
  'apps/desktop/e2e/embedding-worker-renderer.shared.ts'
);

test('desktop workflow dispatches the full suite or the foreground-latency benchmark', async () => {
  const workflow = parseYaml(await readFile(workflowPath, 'utf8'));
  const suiteInput = workflow.on?.workflow_dispatch?.inputs?.suite;

  assert.deepEqual(suiteInput, {
    default: 'full',
    description: 'Desktop E2E suite to run',
    options: ['full', 'foreground-latency'],
    required: true,
    type: 'choice',
  });

  const fullRegression = workflow.jobs?.['desktop-full-regression'];
  assert.equal(
    fullRegression?.if,
    "github.event_name != 'workflow_dispatch' || inputs.suite == 'full'",
    'a foreground-latency dispatch must not spend time in the unrelated full regression'
  );
});

test('the embedding job runs its specs untruncated, each named literally', async () => {
  const workflow = parseYaml(await readFile(workflowPath, 'utf8'));
  const runStep = workflow.jobs?.['desktop-embedding-e2e']?.steps?.find(
    (step) => step.name === 'Run desktop embedding regression'
  );
  const run = runStep?.run ?? '';
  for (const spec of ['smoke', 'search', 'lifecycle']) {
    assert.match(run, new RegExp(`e2e/embedding-worker-renderer\\.${spec}\\.desktop\\.test\\.ts`));
  }
  assert.doesNotMatch(
    run,
    /test_files|max_failures|test_grep/,
    'the reachability gate must see literal Playwright files and options'
  );
  assert.match(run, /--max-failures=0/);
  // BST-1915: one failing spec stopped the nightly and hid 17 never-run specs.
  assert.doesNotMatch(run, /--max-failures=[1-9]/);
});

test('scheduled embedding smoke distinguishes configured WebGPU from unavailable automatic selection', async () => {
  const workflow = parseYaml(await readFile(workflowPath, 'utf8'));
  const embeddingSmoke = await readFile(embeddingSmokePath, 'utf8');
  const embeddingFixture = await readFile(embeddingFixturePath, 'utf8');
  const runStep = workflow.jobs?.['desktop-embedding-e2e']?.steps?.find(
    (step) => step.name === 'Run desktop embedding regression'
  );

  assert.equal(workflow.env?.CI, 'true');
  assert.equal(workflow.env?.ELECTRON_DISABLE_GPU, '1');
  assert.match(runStep?.run ?? '', /--grep="@desktop-embedding-"/);
  assert.match(embeddingSmoke, /@desktop-embedding-webgpu-configured/);
  assert.match(embeddingSmoke, /@desktop-embedding-webgpu-unsupported/);
  assert.match(embeddingSmoke, /BRAINSTRIKE_E2E_ALLOW_GPU:\s*undefined/);
  assert.match(embeddingSmoke, /CI:\s*'true'/);
  assert.match(embeddingSmoke, /ELECTRON_DISABLE_GPU:\s*'1'/);
  assert.match(
    embeddingFixture,
    /Workspace Index requires WebGPU for automatic local embedding execution\./
  );
});
