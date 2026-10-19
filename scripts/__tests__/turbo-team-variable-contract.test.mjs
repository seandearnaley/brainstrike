import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

/**
 * BST-2105: TURBO_TEAM is the Vercel team slug, which every package name and
 * checkout path contains. Passed as a secret, GitHub redacts any job output
 * holding it, so Static's `unit-matrix` was dropped ("Skip output
 * 'unit-matrix' since it may contain secret") and no Unit shard ever ran.
 * Turborepo's GitHub Actions setup reads it as a repository variable.
 *
 * Each check is a function over source text, so the CONTROL test at the end
 * can mutate the real files and watch the check fail.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');
const workflowFiles = readdirSync(workflowsDir).filter((file) => /\.ya?ml$/u.test(file));
const readWorkflow = (file) => readFileSync(path.join(workflowsDir, file), 'utf8');

const SECRET_TEAM = /secrets\.TURBO_TEAM\b/u;
const VARIABLE_TEAM = /TURBO_TEAM:\s*\$\{\{\s*vars\.TURBO_TEAM\s*\}\}/u;

/**
 * Whether the workflow configures the remote cache: TURBO_TOKEN in a workflow,
 * job or step `env`. Forwarding the secret to a called workflow
 * (merge-queue.yml -> test.yml, BST-2188) configures nothing here; the called
 * workflow sets its own env and is checked on its own.
 */
function setsTurboToken(source) {
  const { env, jobs } = parseYaml(source);
  const envs = [
    env,
    ...Object.values(jobs ?? {}).flatMap((job) => [
      job.env,
      ...(job.steps ?? []).map((step) => step.env),
    ]),
  ];
  return envs.some((block) => block && Object.hasOwn(block, 'TURBO_TOKEN'));
}

/** Returns the reasons a workflow's turbo remote-cache identity is wrong. */
function turboTeamViolations(file, source) {
  const violations = [];
  if (SECRET_TEAM.test(source)) {
    violations.push(`${file} reads secrets.TURBO_TEAM; the team slug must be vars.TURBO_TEAM`);
  }
  if (setsTurboToken(source) && !VARIABLE_TEAM.test(source)) {
    violations.push(`${file} sets TURBO_TOKEN without TURBO_TEAM: \${{ vars.TURBO_TEAM }}`);
  }
  return violations;
}

test('no workflow passes the turbo team slug as a secret, and every remote-cache workflow reads it as a variable', () => {
  const violations = workflowFiles.flatMap((file) => turboTeamViolations(file, readWorkflow(file)));
  assert.deepEqual(violations, []);
  assert.ok(
    workflowFiles.some((file) => VARIABLE_TEAM.test(readWorkflow(file))),
    'at least one workflow configures the turbo remote cache'
  );
});

test('CONTROL: the secret form and a token without a team both fail the check', () => {
  const source = readWorkflow('test.yml');
  assert.ok(VARIABLE_TEAM.test(source), 'test.yml configures the turbo remote cache');
  const asSecret = source.replace('vars.TURBO_TEAM', 'secrets.TURBO_TEAM');
  assert.match(turboTeamViolations('test.yml', asSecret).join('\n'), /reads secrets\.TURBO_TEAM/u);
  const withoutTeam = source.replace(VARIABLE_TEAM, '');
  assert.match(
    turboTeamViolations('test.yml', withoutTeam).join('\n'),
    /sets TURBO_TOKEN without TURBO_TEAM/u
  );
});

test('CONTROL: forwarding the token to a called workflow is not configuring the cache', () => {
  const token = `${'$'}{{ secrets.TURBO_TOKEN }}`;
  const forwarding = [
    'jobs:',
    '  test:',
    '    uses: ./.github/workflows/test.yml',
    '    secrets:',
    `      TURBO_TOKEN: ${token}`,
    '',
  ].join('\n');
  assert.deepEqual(turboTeamViolations('caller.yml', forwarding), []);
  const configuring = [
    'jobs:',
    '  build:',
    '    env:',
    `      TURBO_TOKEN: ${token}`,
    '    steps: []',
    '',
  ].join('\n');
  assert.match(
    turboTeamViolations('caller.yml', configuring).join('\n'),
    /sets TURBO_TOKEN without TURBO_TEAM/u
  );
});
