import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const contracts = [
  {
    cron: '47 9 * * *',
    file: 'boundary-crash-fuzzer.yml',
    routine: 'node scripts/deterministic-boundary-crash-fuzzer.mjs',
    timeout: 10,
  },
  {
    cron: '13 10 * * 0',
    file: 'mutation-gap-hardener.yml',
    routine: 'node scripts/mutation-gap-hardener.mjs',
    timeout: 40,
  },
];

function readWorkflow(file) {
  const source = readFileSync(path.join(repoRoot, '.github/workflows', file), 'utf8');
  return { source, workflow: parseYaml(source) };
}

describe('scheduled shadow workflow contract', () => {
  for (const contract of contracts) {
    it(`${contract.file} is one bounded report-only routine owner`, () => {
      const { source, workflow } = readWorkflow(contract.file);
      assert.deepEqual(Object.keys(workflow.on).sort(), ['schedule', 'workflow_dispatch']);
      assert.deepEqual(workflow.on.schedule, [{ cron: contract.cron }]);
      assert.deepEqual(workflow.permissions, { contents: 'read' });
      assert.equal(Object.keys(workflow.jobs).length, 1);

      const [job] = Object.values(workflow.jobs);
      assert.equal(
        job.if,
        "github.event_name != 'workflow_dispatch' || github.ref == 'refs/heads/main'"
      );
      assert.equal(job['timeout-minutes'], contract.timeout);
      assert.deepEqual(job.permissions, undefined);
      assert.equal(job.steps.filter((step) => step.run?.includes(contract.routine)).length, 1);
      const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
      assert.equal(checkout.with['persist-credentials'], false);
      assert.equal(checkout.with.ref, 'refs/heads/main');
      assert.equal(checkout.with['fetch-depth'], 0);
      assert.ok(job.steps.some((step) => step.uses === './.github/actions/setup-report-workspace'));
      const uploads = job.steps.filter((step) => step.uses?.startsWith('actions/upload-artifact@'));
      assert.equal(uploads.length, 1);
      assert.equal(uploads[0].if, 'always()');
      assert.equal(uploads[0].with['if-no-files-found'], 'error');

      assert.doesNotMatch(
        source,
        /pull_request_target|permissions:\s*[\s\S]*?write|\bgh\s+(?:issue|pr)|git\s+(?:commit|push|merge)|auto-merge/iu
      );
      assert.doesNotMatch(source, /\b(?:push|pull_request):/u);
      assert.doesNotMatch(source, /setup-workspace|actions\/cache|turbo-cache/u);
    });
  }
});
