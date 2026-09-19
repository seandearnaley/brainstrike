import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

const root = new URL('../../', import.meta.url);

test('Knip is reachable on schedule and dispatch and failures cannot turn green', () => {
  const workflow = parse(readFileSync(new URL('.github/workflows/knip.yml', root), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on).sort(), ['schedule', 'workflow_dispatch']);
  assert.equal(workflow.on.schedule.length, 1);
  assert.ok(workflow.on.schedule[0].cron);
  const job = workflow.jobs.audit;
  assert.equal(job['continue-on-error'], undefined);
  assert.ok(job['timeout-minutes'] <= 15);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  const commands = job.steps.filter((step) => step.run);
  assert.deepEqual(
    commands.map((step) => step.run),
    ['time pnpm knip', 'node scripts/check-knip-liveness.mjs']
  );
  for (const step of commands) {
    assert.equal(step['continue-on-error'], undefined);
    assert.equal(step.if, undefined);
  }
  const checkout = job.steps.findIndex((step) => step.uses === 'actions/checkout@v6');
  const setup = job.steps.findIndex((step) => step.uses === './.github/actions/setup-workspace');
  assert.ok(checkout >= 0 && setup > checkout);
});
