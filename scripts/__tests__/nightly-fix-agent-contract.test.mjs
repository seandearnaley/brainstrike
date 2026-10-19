import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { CLAIM_LIFETIME_MINUTES } from '../nightly-fix-issue.mjs';

/**
 * BST-2189 Part 2: a fix agent per nightly issue. These are its guardrails:
 * a pinned action, one attempt per issue, bounded turns and time, a read-only
 * token for the agent, no provider keys, no echoed secrets, the action's
 * bot-actor check left on, and a credential gate that fails visibly instead of
 * skipping. Each check is a function over source text, so the CONTROL tests
 * can mutate the real files and watch it fail.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath) => readFileSync(path.join(repoRoot, relativePath), 'utf8');
const AGENT = '.github/workflows/nightly-fix-agent.yml';
const CALLER = '.github/workflows/desktop-e2e.yml';
const ALERT = '.github/workflows/nightly-linear-alert.yml';
const SKILL = '.claude/skills/fix-nightly/SKILL.md';
const ACTION = 'anthropics/claude-code-action';
const expression = (body) => `${'$'}{{ ${body} }}`;
const AGENT_INPUTS = ['claude_args', 'claude_code_oauth_token', 'github_token', 'prompt'];
const DENIED_TOOLS = [
  'Bash(git push *)',
  'Bash(gh pr *)',
  'Bash(pnpm cassettes:record *)',
  'Bash(pnpm cassettes:proxy *)',
];
const MAX_TIMEOUT_MINUTES = 180;

const stepsOf = (job) => job.steps ?? [];
const agentStep = (job) => stepsOf(job).find((step) => String(step.uses).startsWith(`${ACTION}@`));
const secretsIn = (value) =>
  [...JSON.stringify(value ?? {}).matchAll(/secrets\.([A-Z_]+)/gu)].map((m) => m[1]);

function assertActionPinned(source) {
  const uses = source.split('\n').filter((line) => line.includes(`${ACTION}@`));
  assert.equal(uses.length, 1, 'one claude-code-action step');
  assert.match(
    uses[0],
    new RegExp(`uses: ${ACTION}@[0-9a-f]{40} # v\\d+\\.\\d+\\.\\d+$`, 'u'),
    'pin the action to a commit SHA with its version in a comment'
  );
}

function assertFixJob(source) {
  const { jobs } = parseYaml(source);
  const fix = jobs.fix;
  assert.equal(
    fix.concurrency?.group,
    `nightly-fix-${expression('inputs.issue')}`,
    'one attempt per issue'
  );
  assert.equal(fix.concurrency['cancel-in-progress'], false);
  assert.ok(
    Number.isInteger(fix['timeout-minutes']) && fix['timeout-minutes'] <= MAX_TIMEOUT_MINUTES,
    'the fix job has a bounded timeout'
  );
  assert.deepEqual(
    fix.permissions,
    { actions: 'read', contents: 'read' },
    'the agent job is read-only'
  );
  assert.equal(fix.env, undefined, 'no job-level environment reaches the agent');

  const steps = stepsOf(fix);
  const agent = agentStep(fix);
  assert.ok(agent, 'the fix job runs claude-code-action');
  assert.deepEqual(
    Object.keys(agent.with).sort(),
    AGENT_INPUTS,
    'only the documented inputs this job needs'
  );
  assert.equal(
    agent.with.github_token,
    expression('github.token'),
    'the agent gets the read-only job token'
  );
  assert.equal(agent.with.prompt, `/fix-nightly ${expression('inputs.issue')}`);
  assert.equal(agent.with.claude_code_oauth_token, expression('secrets.CLAUDE_CODE_OAUTH_TOKEN'));
  assert.match(agent.with.claude_args, /--max-turns \d+\b/u, 'the agent has a turn budget');
  const denied = /--disallowedTools "([^"]+)"/u.exec(agent.with.claude_args)?.[1].split(',') ?? [];
  for (const rule of DENIED_TOOLS) {
    assert.ok(denied.includes(rule), `the agent is denied ${rule}`);
  }
  assert.deepEqual(secretsIn(agent.env), [], 'the agent step environment carries no secret');

  const gate = steps.findIndex((step) => step.name === 'Require the fix agent credential');
  const claim = steps.findIndex((step) => step.id === 'claim');
  assert.equal(gate, 0, 'the credential gate runs first');
  assert.ok(claim > gate && steps.indexOf(agent) > claim, 'gate, then claim, then agent');
  assert.match(
    String(agent.if),
    /steps\.claim\.outputs\.claimed == 'true'/u,
    'a held issue skips the agent'
  );
}

function assertSecretsStayScoped(source) {
  const workflow = parseYaml(source);
  const declared = Object.keys(workflow.on.workflow_call.secrets).sort();
  assert.deepEqual(declared, ['CLAUDE_CODE_OAUTH_TOKEN', 'LINEAR_API_KEY']);
  assert.deepEqual(
    [...new Set(source.match(/\b[A-Z_]*API_KEY\b/gu))],
    ['LINEAR_API_KEY'],
    'no provider API key appears in the fix agent workflow'
  );
  assert.doesNotMatch(
    source,
    /show_full_output|ACTIONS_STEP_DEBUG/u,
    'full agent output is never logged'
  );
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    for (const step of stepsOf(job)) {
      if (secretsIn(step.env).includes('LINEAR_API_KEY')) {
        assert.match(
          String(step.run),
          /^\s*(?:[\s\S]*\n)?\s*node scripts\/nightly-fix-issue\.mjs /mu,
          `${jobId} › ${step.name}: only the Linear script reads LINEAR_API_KEY`
        );
      }
    }
  }
}

/** A bot claim may go stale only once no run that made it can still be alive. */
function assertClaimOutlivesRuns(source) {
  const { jobs } = parseYaml(source);
  const longestRun = jobs.fix['timeout-minutes'] + jobs.publish['timeout-minutes'];
  assert.ok(
    CLAIM_LIFETIME_MINUTES > longestRun,
    `CLAIM_LIFETIME_MINUTES (${CLAIM_LIFETIME_MINUTES}) must exceed the fix and publish timeouts (${longestRun})`
  );
}

function assertPublishJob(source) {
  const publish = parseYaml(source).jobs.publish;
  assert.deepEqual(publish.needs, ['fix']);
  assert.deepEqual(publish.permissions, { contents: 'write', 'pull-requests': 'write' });
  const script = stepsOf(publish)
    .map((step) => step.run ?? '')
    .join('\n');
  assert.match(script, /branch="nightly-fix\//u, 'publishes only a nightly-fix/ branch');
  assert.match(script, /git push origin "refs\/heads\/\$branch:refs\/heads\/\$branch"/u);
  assert.match(script, /printf 'Fixes %s\\n\\n' "\$ISSUE"/u, 'the PR body carries Fixes <issue>');
  assert.match(script, /gh pr create --base main /u);
  assert.doesNotMatch(
    script,
    /gh pr merge|--auto|git push[^\n]*\bmain\b/u,
    'the workflow never merges'
  );
}

function assertCaller(source) {
  const { jobs } = parseYaml(source);
  const fix = jobs['fix-nightly'];
  assert.ok(fix, 'Desktop E2E runs the fix agent');
  assert.deepEqual(fix.needs, ['notify-linear']);
  assert.equal(fix.uses, `./${AGENT}`);
  assert.match(String(fix.if), /needs\.notify-linear\.outputs\.fix_issues != '\[\]'/u);
  assert.equal(
    fix.strategy.matrix.issue,
    expression('fromJSON(needs.notify-linear.outputs.fix_issues)')
  );
  assert.equal(fix.with.issue, expression('matrix.issue'));
  const laneRunners = new Set(
    Object.values(jobs)
      .filter((job) =>
        stepsOf(job).some((step) =>
          /\bplaywright test\b|test:e2e:lane:/u.test(String(step.run ?? ''))
        )
      )
      .map((job) => job['runs-on'])
  );
  assert.deepEqual(
    [...laneRunners],
    [fix.with.runs_on],
    'the agent runs on the failing lanes’ runner image'
  );
  assert.deepEqual(Object.keys(fix.secrets).sort(), ['CLAUDE_CODE_OAUTH_TOKEN', 'LINEAR_API_KEY']);
}

function assertAlertPublishesQueue(source) {
  const workflow = parseYaml(source);
  assert.equal(
    workflow.on.workflow_call.outputs.fix_issues.value,
    expression('jobs.notify.outputs.fix_issues')
  );
  assert.equal(
    workflow.jobs.notify.outputs.fix_issues,
    expression('steps.file.outputs.fix_issues')
  );
  assert.ok(stepsOf(workflow.jobs.notify).some((step) => step.id === 'file'));
}

/** Runs the credential gate's own script, as the runner would. */
function runGate(source, hasCredential) {
  const gate = stepsOf(parseYaml(source).jobs.fix)[0];
  return spawnSync('bash', ['-e', '-c', gate.run], {
    encoding: 'utf8',
    env: { HAS_CLAUDE_CREDENTIAL: hasCredential, ISSUE: 'BST-3000', PATH: process.env.PATH },
  });
}

function assertGateFailsVisibly(source) {
  const missing = runGate(source, 'false');
  assert.equal(missing.status, 1, 'a missing credential fails the job, never skips it');
  assert.match(
    missing.stdout,
    /^::error title=Nightly fix agent not configured::.*CLAUDE_CODE_OAUTH_TOKEN/mu
  );
  assert.match(missing.stdout, /BST-3000 was left unclaimed/u);
  assert.equal(runGate(source, 'true').status, 0);
  const gate = parseYaml(source).jobs.fix.steps[0];
  assert.equal(gate.env.HAS_CLAUDE_CREDENTIAL, expression("secrets.CLAUDE_CODE_OAUTH_TOKEN != ''"));
}

test('the action is pinned to a commit SHA with its version', () => {
  assertActionPinned(read(AGENT));
});

test('the fix job: one attempt per issue, bounded, read-only, gate then claim then agent', () => {
  assertFixJob(read(AGENT));
});

test('only the Linear script sees LINEAR_API_KEY, and no provider key exists', () => {
  assertSecretsStayScoped(read(AGENT));
});

test('a deterministic job publishes the branch and PR, and nothing merges', () => {
  assertPublishJob(read(AGENT));
});

test('a bot claim outlives every run that could hold it', () => {
  assertClaimOutlivesRuns(read(AGENT));
});

test('the agent is told which run’s artifacts are tonight’s evidence', () => {
  const agent = agentStep(parseYaml(read(AGENT)).jobs.fix);
  assert.equal(agent.env.NIGHTLY_FIX_RUN_ID, expression('github.run_id'));
  assert.match(read(SKILL), /\$NIGHTLY_FIX_RUN_ID/u);
});

test('CONTROL: a fix job timeout past the claim lifetime FAILS', () => {
  const mutated = mutate(read(AGENT), 'timeout-minutes: 120', 'timeout-minutes: 175');
  assert.throws(() => assertClaimOutlivesRuns(mutated), /must exceed/u);
});

test('a missing credential fails the job visibly before any claim', () => {
  assertGateFailsVisibly(read(AGENT));
});

test('Desktop E2E queues one agent per issue on its lanes’ runner', () => {
  assertCaller(read(CALLER));
  assertAlertPublishesQueue(read(ALERT));
});

test('the fix-nightly skill is versioned and user-invoked', () => {
  const skill = read(SKILL);
  assert.match(skill, /^---\nname: fix-nightly\n/u);
  assert.match(skill, /^disable-model-invocation: true$/mu);
  const ignored = spawnSync('git', ['check-ignore', '-q', SKILL], { cwd: repoRoot });
  assert.equal(ignored.status, 1, `${SKILL} must not be gitignored`);
});

function mutate(source, from, to) {
  const mutated = source.replace(from, to);
  assert.notEqual(mutated, source, `control mutation ${String(from)} matched nothing`);
  return mutated;
}

test('CONTROL: a floating action tag FAILS the pin check', () => {
  const mutated = mutate(read(AGENT), /@[0-9a-f]{40} # v[\d.]+/u, '@v1');
  assert.throws(() => assertActionPinned(mutated), /commit SHA/u);
});

test('CONTROL: allowing bots, dropping the turn cap or the concurrency group FAILS', () => {
  const source = read(AGENT);
  const bots = mutate(
    source,
    '          prompt: /fix-nightly',
    "          allowed_bots: '*'\n          prompt: /fix-nightly"
  );
  assert.throws(() => assertFixJob(bots), /documented inputs/u);
  const turns = mutate(source, /\n {12}--max-turns \d+/u, '');
  assert.throws(() => assertFixJob(turns), /turn budget/u);
  const unbounded = mutate(
    source,
    /\n {4}concurrency:\n {6}group: [^\n]+\n {6}cancel-in-progress: false/u,
    ''
  );
  assert.throws(() => assertFixJob(unbounded), /one attempt per issue/u);
});

test('CONTROL: a writable agent token FAILS the read-only check', () => {
  const source = read(AGENT);
  const writable = mutate(
    source,
    '      actions: read\n      contents: read\n    outputs:',
    '      actions: read\n      contents: write\n    outputs:'
  );
  assert.throws(() => assertFixJob(writable), /read-only/u);
  const appToken = mutate(source, `          github_token: ${expression('github.token')}\n`, '');
  assert.throws(() => assertFixJob(appToken), /documented inputs/u);
});

test('CONTROL: a provider key or Linear key in the agent environment FAILS', () => {
  const source = read(AGENT);
  const agentEnv = `          NIGHTLY_FIX_OUT: ${expression('runner.temp')}/nightly-fix`;
  const withSecret = (name) =>
    mutate(source, agentEnv, `${agentEnv}\n          ${name}: ${expression(`secrets.${name}`)}`);
  assert.throws(
    () => assertSecretsStayScoped(withSecret('OPENAI_API_KEY')),
    /no provider API key/u
  );
  const linear = withSecret('LINEAR_API_KEY');
  assert.throws(() => assertFixJob(linear), /carries no secret/u);
});

test('CONTROL: a gate that skips quietly FAILS the visible-failure check', () => {
  const quiet = mutate(
    read(AGENT),
    /\n {12}exit 1\n {10}fi/u,
    '\n            exit 0\n          fi'
  );
  assert.throws(() => assertGateFailsVisibly(quiet), /never skips/u);
});

test('CONTROL: a publish step that merges FAILS', () => {
  const merging = mutate(
    read(AGENT),
    '          echo "url=$url" >> "$GITHUB_OUTPUT"',
    '          echo "url=$url" >> "$GITHUB_OUTPUT"\n          gh pr merge "$url" --squash'
  );
  assert.throws(() => assertPublishJob(merging), /never merges/u);
});
