import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
 * skipping.
 *
 * BST-2235 (owner decision 2026-10-19): the fix agents run after the night, in
 * nightly-fix.yml, which GitHub starts as its own run when a Nightly run
 * completes (`on: workflow_run`), so an agent's failure turns that run red and
 * never the night. Desktop E2E's Notify Linear uploads the night's queue as an
 * artifact of the nightly run. A workflow_run run executes the default
 * branch's file with github.sha at main's head, so the agent builds on the
 * night's commit (workflow_run.head_sha) and reads the night's run instead.
 *
 * Each check is a function over source text, so the CONTROL tests can mutate
 * the real files and watch it fail.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath) => readFileSync(path.join(repoRoot, relativePath), 'utf8');
const AGENT = '.github/workflows/nightly-fix-agent.yml';
const FOLLOW_UP = '.github/workflows/nightly-fix.yml';
const NIGHTLY = '.github/workflows/nightly.yml';
const DESKTOP = '.github/workflows/desktop-e2e.yml';
const ALERT = '.github/workflows/nightly-linear-alert.yml';
const SKILL = '.claude/skills/fix-nightly/SKILL.md';
const QUEUE_ARTIFACT = 'nightly-fix-issues';
const FORK_GUARD = "github.repository == 'seandearnaley/brainstrike'";
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

const SCHEDULED_NIGHT =
  "(github.event_name == 'workflow_dispatch' || github.event.workflow_run.event == 'schedule')";

/** The follow-up starts once a Nightly run completes, and works only a scheduled night. */
function assertFollowUpTrigger(source, nightlySource) {
  const workflow = parseYaml(source);
  assert.deepEqual(
    Object.keys(workflow.on).sort(),
    ['workflow_dispatch', 'workflow_run'],
    'the fix agents run after a Nightly run completes, or on a manual dispatch'
  );
  assert.deepEqual(
    workflow.on.workflow_run,
    { types: ['completed'], workflows: [parseYaml(nightlySource).name] },
    'the follow-up starts once the whole Nightly run has completed'
  );
  const runId = workflow.on.workflow_dispatch.inputs?.run_id;
  assert.equal(runId?.required, true, 'a dispatch names the Nightly run to work');
  assert.equal(runId?.type, 'string');
  assert.deepEqual(workflow.permissions, {}, 'the follow-up grants nothing by default');
  assert.equal(
    workflow.jobs.queue?.if,
    `${FORK_GUARD} && ${SCHEDULED_NIGHT}`,
    'only a scheduled night, or a dispatch, queues fix agents'
  );
}

/** One agent per queued issue, given what the agent workflow needs and nothing more. */
function assertFollowUpCalls(source) {
  const { jobs } = parseYaml(source);
  assert.deepEqual(
    Object.keys(jobs).sort(),
    ['fix', 'queue'],
    'the follow-up reads the queue, then fixes'
  );
  const { fix, queue } = jobs;
  assert.deepEqual(queue.permissions, { actions: 'read' }, 'the queue job only reads the night');
  const steps = stepsOf(queue);
  const nightly = steps.findIndex((step) => step.id === 'nightly');
  const download = steps.findIndex((step) =>
    String(step.uses).startsWith('actions/download-artifact@')
  );
  const list = steps.findIndex((step) => step.id === 'queue');
  assert.ok(
    nightly >= 0 && nightly < download && download < list,
    'name the night’s run, download its queue, then list it'
  );
  assert.deepEqual(
    steps[download].with,
    {
      'github-token': expression('github.token'),
      name: QUEUE_ARTIFACT,
      path: `${expression('runner.temp')}/nightly-fix`,
      'run-id': expression('steps.nightly.outputs.run_id'),
    },
    'the queue is downloaded by name from the night’s run, so a missing queue fails the run'
  );
  assert.equal(queue.outputs?.queue, expression('steps.queue.outputs.queue'));

  assert.deepEqual(fix.needs, ['queue']);
  assert.equal(fix.uses, `./${AGENT}`);
  assert.equal(fix.if, "needs.queue.outputs.queue != '[]'");
  assert.equal(fix.strategy?.['fail-fast'], false, 'one agent’s failure leaves the others running');
  assert.equal(fix.strategy.matrix.include, expression('fromJSON(needs.queue.outputs.queue)'));
  assert.equal(fix.with.issue, expression('matrix.issue'));
  assert.equal(fix.with.runs_on, expression('matrix.runs_on'));
  assert.deepEqual(
    fix.permissions,
    { actions: 'read', contents: 'write', 'pull-requests': 'write' },
    'the call grants what the agent workflow’s jobs ask for'
  );
  assert.deepEqual(
    fix.secrets,
    {
      CLAUDE_CODE_OAUTH_TOKEN: expression('secrets.CLAUDE_CODE_OAUTH_TOKEN'),
      LINEAR_API_KEY: expression('secrets.LINEAR_API_KEY'),
    },
    'the call passes the agent its two secrets by name'
  );
  assert.deepEqual(
    [...new Set(secretsIn(jobs))].sort(),
    ['CLAUDE_CODE_OAUTH_TOKEN', 'LINEAR_API_KEY'],
    'the follow-up reads no other secret'
  );
}

/** The agent builds on the night's commit and reads the night's run, never main's head. */
function assertNightsCommit(followUpSource, agentSource) {
  for (const [file, source] of [
    [FOLLOW_UP, followUpSource],
    [AGENT, agentSource],
  ]) {
    assert.doesNotMatch(
      source,
      /\bgithub\.sha\b/u,
      `${file}: under workflow_run github.sha is main's head, not the night's commit`
    );
  }
  const { jobs } = parseYaml(followUpSource);
  const nightly = stepsOf(jobs.queue).find((step) => step.id === 'nightly');
  assert.equal(
    nightly?.env?.NIGHTLY_RUN_ID,
    expression('github.event.workflow_run.id'),
    'the night’s run is the triggering run'
  );
  assert.equal(
    nightly.env.NIGHTLY_HEAD_SHA,
    expression('github.event.workflow_run.head_sha'),
    'the night’s commit is the triggering run’s head_sha, not main’s head'
  );
  assert.equal(jobs.queue.outputs.run_id, expression('steps.nightly.outputs.run_id'));
  assert.equal(jobs.queue.outputs.head_sha, expression('steps.nightly.outputs.head_sha'));
  assert.equal(jobs.fix.with.nightly_run_id, expression('needs.queue.outputs.run_id'));
  assert.equal(jobs.fix.with.head_sha, expression('needs.queue.outputs.head_sha'));

  const agent = parseYaml(agentSource);
  for (const input of ['head_sha', 'nightly_run_id']) {
    assert.equal(agent.on.workflow_call.inputs[input]?.required, true, `${AGENT} needs ${input}`);
  }
  const pinned = { BASE_SHA: 0, checkout: 0 };
  for (const [jobId, job] of Object.entries(agent.jobs)) {
    for (const step of stepsOf(job)) {
      if (String(step.uses).startsWith('actions/checkout@')) {
        assert.equal(
          step.with?.ref,
          expression('inputs.head_sha'),
          `${jobId} › ${step.name} checks out the night's commit`
        );
        pinned.checkout += 1;
      }
      if (step.env?.BASE_SHA !== undefined) {
        assert.equal(
          step.env.BASE_SHA,
          expression('inputs.head_sha'),
          `${jobId} › ${step.name} builds on the night's commit`
        );
        pinned.BASE_SHA += 1;
      }
    }
  }
  assert.deepEqual(pinned, { BASE_SHA: 2, checkout: 2 }, 'the fix and publish jobs both pin it');
  assert.equal(
    agentStep(agent.jobs.fix).env.NIGHTLY_FIX_RUN_ID,
    expression('inputs.nightly_run_id'),
    'the agent’s evidence is the night’s run'
  );
  const claim = stepsOf(agent.jobs.fix).find((step) => step.id === 'claim');
  assert.equal(
    claim.env.NIGHTLY_RUN_URL,
    `${expression('github.server_url')}/${expression('github.repository')}/actions/runs/${expression('inputs.nightly_run_id')}`
  );
  assert.match(
    claim.run,
    /--run-url "\$NIGHTLY_RUN_URL"/u,
    'the claim reads tonight’s failure from the night’s run'
  );
}

/** Notify Linear uploads the queue only for a workflow that names its lanes' runner. */
function assertAlertPublishesQueue(source) {
  const workflow = parseYaml(source);
  const call = workflow.on.workflow_call;
  assert.deepEqual(call.inputs.fix_runs_on, { default: '', required: false, type: 'string' });
  assert.equal(
    call.outputs,
    undefined,
    'the queue is an artifact of the nightly run, not an output'
  );
  assert.equal(workflow.jobs.notify.outputs, undefined);
  const steps = stepsOf(workflow.jobs.notify);
  const file = steps.findIndex((step) => step.id === 'file');
  const write = steps.findIndex((step) => step.id === 'fix-queue');
  const upload = steps.findIndex((step) =>
    String(step.uses).startsWith('actions/upload-artifact@')
  );
  assert.ok(
    file >= 0 && file < write && write < upload,
    'file to Linear, write the queue, then upload it'
  );
  for (const step of [steps[write], steps[upload]]) {
    assert.equal(
      step.if,
      "inputs.fix_runs_on != ''",
      `${step.name} runs only for a queueing workflow`
    );
  }
  assert.deepEqual(steps[write].env, {
    FIX_ISSUES: expression('steps.file.outputs.fix_issues'),
    RUNS_ON: expression('inputs.fix_runs_on'),
  });
  assert.deepEqual(steps[upload].with, {
    'if-no-files-found': 'error',
    name: QUEUE_ARTIFACT,
    path: `${expression('runner.temp')}/fix-issues.json`,
    'retention-days': 7,
  });
}

/** Desktop E2E queues its tests' issues for agents on its lanes' runner image. */
function assertDesktopQueues(source) {
  const { jobs } = parseYaml(source);
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
    [jobs['notify-linear'].with?.fix_runs_on],
    'the agent runs on the failing lanes’ runner image'
  );
}

/** An artifact name is unique within a run, so one workflow of the night queues fix agents. */
function assertOneQueuePerNight(nightlySource, readFile) {
  const queueing = Object.values(parseYaml(nightlySource).jobs)
    .map((job) => String(job.uses ?? ''))
    .filter((uses) => uses.startsWith('./.github/workflows/'))
    .filter((uses) =>
      Object.values(parseYaml(readFile(uses.slice(2))).jobs).some(
        (job) => job.with?.fix_runs_on !== undefined
      )
    );
  assert.deepEqual(queueing, [`./${DESKTOP}`], `one workflow per night uploads ${QUEUE_ARTIFACT}`);
}

/**
 * Runs a step's script as the runner would, in a scratch RUNNER_TEMP with a
 * GITHUB_OUTPUT file and a fake `gh` on PATH that logs its arguments and
 * prints FAKE_GH_RUN.
 */
function runStep(step, env = {}, files = {}, collect = []) {
  const dir = mkdtempSync(path.join(tmpdir(), 'nightly-fix-step-'));
  try {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    const gh = path.join(bin, 'gh');
    writeFileSync(
      gh,
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$FAKE_GH_LOG"\nprintf \'%s\\n\' "$FAKE_GH_RUN"\n'
    );
    chmodSync(gh, 0o755);
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), content);
    }
    const output = path.join(dir, 'output');
    const ghLog = path.join(dir, 'gh.log');
    writeFileSync(output, '');
    writeFileSync(ghLog, '');
    const result = spawnSync('bash', ['-e', '-c', step.run], {
      encoding: 'utf8',
      env: {
        FAKE_GH_LOG: ghLog,
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_STEP_SUMMARY: '/dev/null',
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: dir,
        ...env,
      },
    });
    const temp = (name) => readFileSync(path.join(dir, name), 'utf8');
    return {
      ...result,
      collected: Object.fromEntries(collect.map((name) => [name, temp(name)])),
      ghCalls: temp('gh.log'),
      output: temp('output'),
    };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

const SHA = { dispatched: 'b'.repeat(40), night: 'a'.repeat(40) };
const nightlyStep = (source) =>
  stepsOf(parseYaml(source).jobs.queue).find((step) => step.id === 'nightly');
const runNightlyStep = (source, env) =>
  runStep(nightlyStep(source), {
    DISPATCHED_RUN_ID: '',
    NIGHTLY_HEAD_SHA: '',
    NIGHTLY_RUN_ID: '',
    ...env,
  });

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
  assert.equal(agent.env.NIGHTLY_FIX_RUN_ID, expression('inputs.nightly_run_id'));
  assert.match(read(SKILL), /\$NIGHTLY_FIX_RUN_ID/u);
});

test('the follow-up starts once a scheduled Nightly run completes, or on dispatch', () => {
  assertFollowUpTrigger(read(FOLLOW_UP), read(NIGHTLY));
});

test('the follow-up reads the night’s queue and calls one agent per issue', () => {
  assertFollowUpCalls(read(FOLLOW_UP));
});

test('the agent builds on the night’s commit and reads the night’s run, never main’s head', () => {
  assertNightsCommit(read(FOLLOW_UP), read(AGENT));
});

test('on workflow_run the night is the triggering run, with no API call', () => {
  const result = runNightlyStep(read(FOLLOW_UP), {
    GITHUB_EVENT_NAME: 'workflow_run',
    NIGHTLY_HEAD_SHA: SHA.night,
    NIGHTLY_RUN_ID: '555',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.output, `run_id=555\nhead_sha=${SHA.night}\n`);
  assert.equal(result.ghCalls, '');
});

test('a dispatch works only a scheduled Nightly run, from that run’s own commit', () => {
  const source = read(FOLLOW_UP);
  const dispatch = (run) =>
    runNightlyStep(source, {
      DISPATCHED_RUN_ID: '777',
      FAKE_GH_RUN: run,
      GITHUB_EVENT_NAME: 'workflow_dispatch',
    });
  const nightly = dispatch(`.github/workflows/nightly.yml\tschedule\t${SHA.dispatched}`);
  assert.equal(nightly.status, 0, nightly.stdout + nightly.stderr);
  assert.equal(nightly.output, `run_id=777\nhead_sha=${SHA.dispatched}\n`);
  assert.match(nightly.ghCalls, /^api repos\/o\/r\/actions\/runs\/777 /u);
  for (const run of [
    `.github/workflows/nightly.yml\tworkflow_dispatch\t${SHA.dispatched}`,
    `.github/workflows/desktop-e2e.yml\tschedule\t${SHA.dispatched}`,
  ]) {
    const refused = dispatch(run);
    assert.notEqual(refused.status, 0, run);
    assert.match(refused.stdout, /^::error::Run 777 is .* not a scheduled Nightly run/mu, run);
    assert.equal(refused.output, '', 'a refused run names no night');
  }
});

test('a night with no full commit SHA is refused, never worked from main', () => {
  for (const sha of ['', 'main', SHA.night.slice(1)]) {
    const result = runNightlyStep(read(FOLLOW_UP), {
      GITHUB_EVENT_NAME: 'workflow_run',
      NIGHTLY_HEAD_SHA: sha,
      NIGHTLY_RUN_ID: '555',
    });
    assert.notEqual(result.status, 0, `head_sha "${sha}"`);
    assert.match(result.stdout, /^::error::/mu);
    assert.equal(result.output, '');
  }
});

test('Notify Linear writes the queue the follow-up lists, one agent per issue', () => {
  const alert = stepsOf(parseYaml(read(ALERT)).jobs.notify).find((s) => s.id === 'fix-queue');
  const written = runStep(
    alert,
    { FIX_ISSUES: '["BST-7","BST-9"]', RUNS_ON: 'ubuntu-latest' },
    {},
    ['fix-issues.json']
  );
  assert.equal(written.status, 0, written.stdout + written.stderr);
  const listStep = stepsOf(parseYaml(read(FOLLOW_UP)).jobs.queue).find((s) => s.id === 'queue');
  const listed = runStep(
    listStep,
    {},
    {
      'nightly-fix/fix-issues.json': written.collected['fix-issues.json'],
    }
  );
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  assert.equal(
    listed.output,
    'queue=[{"issue":"BST-7","runs_on":"ubuntu-latest"},{"issue":"BST-9","runs_on":"ubuntu-latest"}]\n'
  );
  const empty = runStep(
    listStep,
    {},
    {
      'nightly-fix/fix-issues.json': '{"runs_on":"ubuntu-latest","issues":[]}\n',
    }
  );
  assert.equal(empty.output, 'queue=[]\n', 'a night with nothing to fix queues no agent');
  const malformed = runStep(listStep, {}, { 'nightly-fix/fix-issues.json': '{"runs_on":"x"}\n' });
  assert.notEqual(malformed.status, 0, 'a queue with no issues list fails the run');
  assert.equal(malformed.output, '');
});

test('Notify Linear uploads the queue only for a workflow that names its lanes’ runner', () => {
  assertAlertPublishesQueue(read(ALERT));
});

test('Desktop E2E queues its issues for agents on its lanes’ runner, alone of the night', () => {
  assertDesktopQueues(read(DESKTOP));
  assertOneQueuePerNight(read(NIGHTLY), read);
});

test('CONTROL: the follow-up on main’s head instead of the night’s commit FAILS', () => {
  const source = read(FOLLOW_UP);
  const mainHead = mutate(source, 'github.event.workflow_run.head_sha', 'github.sha');
  assert.throws(() => assertNightsCommit(mainHead, read(AGENT)), /main's head/u);
  const unpinned = mutate(read(AGENT), /\n {10}ref: \$\{\{ inputs\.head_sha \}\}/gu, '');
  assert.throws(() => assertNightsCommit(source, unpinned), /checks out the night's commit/u);
});

test('CONTROL: a follow-up for any Nightly event, or a queue read elsewhere, FAILS', () => {
  const source = read(FOLLOW_UP);
  const anyEvent = mutate(source, SCHEDULED_NIGHT, "github.event_name != ''");
  assert.throws(() => assertFollowUpTrigger(anyEvent, read(NIGHTLY)), /only a scheduled night/u);
  const ownRun = mutate(source, /\n {10}run-id: [^\n]+/u, '');
  assert.throws(() => assertFollowUpCalls(ownRun), /from the night’s run/u);
  const failFast = mutate(source, 'fail-fast: false', 'fail-fast: true');
  assert.throws(() => assertFollowUpCalls(failFast), /leaves the others running/u);
});

test('CONTROL: a fix job timeout past the claim lifetime FAILS', () => {
  const mutated = mutate(read(AGENT), 'timeout-minutes: 120', 'timeout-minutes: 175');
  assert.throws(() => assertClaimOutlivesRuns(mutated), /must exceed/u);
});

test('a missing credential fails the job visibly before any claim', () => {
  assertGateFailsVisibly(read(AGENT));
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
