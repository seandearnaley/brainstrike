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

test('desktop workflow exposes an untruncated memory-baseline dispatch', async () => {
  const workflow = parseYaml(await readFile(workflowPath, 'utf8'));
  const suiteInput = workflow.on?.workflow_dispatch?.inputs?.suite;

  assert.deepEqual(suiteInput, {
    default: 'full',
    description: 'Desktop E2E suite to run',
    options: ['full', 'memory-baseline'],
    required: true,
    type: 'choice',
  });

  const fullRegression = workflow.jobs?.['desktop-full-regression'];
  assert.equal(
    fullRegression?.if,
    "github.event_name != 'workflow_dispatch' || inputs.suite == 'full'",
    'memory-baseline dispatches must not spend time in the unrelated full regression'
  );

  const embeddingJob = workflow.jobs?.['desktop-embedding-e2e'];
  const runStep = embeddingJob?.steps?.find(
    (step) => step.name === 'Run desktop embedding regression'
  );
  assert.match(runStep?.env?.DESKTOP_E2E_SUITE ?? '', /^\$\{\{ inputs\.suite \|\| 'full' \}\}$/);
  assert.match(runStep?.run ?? '', /memory-baseline/);
  assert.match(runStep?.run ?? '', /e2e\/embedding-worker-renderer\.memory\.desktop\.test\.ts/);
  assert.match(
    runStep?.run ?? '',
    /if \[\[ "\$DESKTOP_E2E_SUITE" == "memory-baseline" \]\]; then[\s\S]*?e2e\/database-live-query-memory\.desktop\.test\.ts[\s\S]*?\n\s*else/,
    'memory-baseline dispatch must run the database live-query memory regression'
  );
  assert.match(
    runStep?.run ?? '',
    /\n\s*else\n[\s\S]*?e2e\/database-live-query-memory\.desktop\.test\.ts[\s\S]*?\n\s*fi/,
    'the scheduled nightly full suite must also run the database live-query memory regression'
  );
  assert.doesNotMatch(
    runStep?.run ?? '',
    /test_files|max_failures|test_grep/,
    'the reachability gate must see literal Playwright files and options in each branch'
  );
  assert.match(runStep?.run ?? '', /--max-failures=0/);
  assert.match(runStep?.run ?? '', /--max-failures=1/);
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
