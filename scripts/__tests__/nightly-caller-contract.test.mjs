import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { resultsArtifactPattern } from '../lib/nightly-test-results.mjs';

/**
 * BST-2233 (owner decision 2026-10-19): one scheduled run of nightly.yml calls
 * the six required nightlies as reusable workflows, so every job of the night
 * runs on one github.sha and a release (BST-2190) can find a commit on which
 * all of them passed.
 *
 * In a called workflow the `github` context is the caller's: github.workflow,
 * github.event_name and github.run_id are nightly.yml's. These checks hold what
 * follows from that, each against GitHub's documented rules:
 * - concurrency: a called workflow's group never equals its caller's or a
 *   sibling's;
 * - permissions: a called workflow can only narrow what its caller grants, so
 *   each call grants what its workflow and the workflows it calls ask for;
 * - secrets: each call passes every secret its workflow declares, never
 *   `inherit`;
 * - limits: at most ten levels and 50 unique reusable workflows;
 * - artifacts: one run is one artifact namespace, so no two workflows'
 *   artifacts may collide and no download may reach another workflow's;
 * - the verdict: the run fails unless every call succeeded;
 * - only tests: no workflow of the night runs a fix agent. BST-2235 (owner
 *   decision 2026-10-19): the agents run after the night in nightly-fix.yml,
 *   which GitHub starts as its own run (`on: workflow_run`), so an agent's
 *   failure never changes this run's conclusion, which a release resolves a
 *   commit by.
 *
 * Each check is a function over source text, so the CONTROL tests can mutate
 * the real files and watch the check fail.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');
const readWorkflow = (file) => readFileSync(path.join(workflowsDir, file), 'utf8');
const allWorkflows = () =>
  new Map(
    readdirSync(workflowsDir)
      .filter((file) => /\.ya?ml$/u.test(file))
      .map((file) => [file, readWorkflow(file)])
  );

const NIGHTLY = 'nightly.yml';
const NIGHTLY_CALLS = [
  'desktop-e2e.yml',
  'native-package-matrix.yml',
  'nightly-coverage.yml',
  'performance.yml',
  'test.yml',
  'web-e2e.yml',
];
// A night is a full run of each workflow: these are the only inputs it passes.
const NIGHTLY_INPUTS = new Map([
  ['desktop-e2e.yml', { suite: 'full' }],
  ['test.yml', { 'merge-queue': false }],
]);
const FORK_GUARD = "github.repository == 'seandearnaley/brainstrike'";
const VERDICT = 'verdict';
const JUDGE_STEP = 'Judge every called workflow';
const LOCAL_WORKFLOW = './.github/workflows/';
const MAX_LEVELS = 10;
const MAX_UNIQUE_REUSABLE = 50;
const LEVEL = { none: 0, read: 1, write: 2 };
const EXPRESSION = /\$\{\{.*?\}\}/gu;

const actions = (body) => `${'$'}{{ ${body} }}`;
const RESULTS_PATTERN = actions('steps.results-artifacts.outputs.pattern');
const stem = (file) => file.replace(/\.ya?ml$/u, '');
const resultEnv = (id) => `RESULT_${id.toUpperCase().replaceAll('-', '_')}`;

/** The local reusable workflows a workflow's jobs call. */
function callsOf(source) {
  return Object.entries(parseYaml(source).jobs ?? {})
    .filter(([, job]) => String(job.uses ?? '').startsWith(LOCAL_WORKFLOW))
    .map(([id, job]) => ({ file: job.uses.slice(LOCAL_WORKFLOW.length), id, job }));
}

function assertCalls(source, sources) {
  const calls = callsOf(source);
  assert.deepEqual(
    calls.map(({ file }) => file).sort(),
    NIGHTLY_CALLS,
    `${NIGHTLY} must call exactly the six required nightlies`
  );
  for (const { file, id, job } of calls) {
    const where = `${NIGHTLY} › ${id}`;
    assert.equal(id, stem(file), `${where} is named for ${file}`);
    assert.equal(
      job.name,
      parseYaml(sources.get(file)).name,
      `${where} carries ${file}'s name, so its checks read "<workflow> / <job>"`
    );
    assert.equal(job.if, FORK_GUARD, `${where} runs only in this repository`);
    assert.equal(job.needs, undefined, `${where} starts with the other calls`);
    assert.deepEqual(job.with, NIGHTLY_INPUTS.get(file), `${where} runs ${file} in full`);
  }
}

/** Every `secrets.<NAME>` a workflow's jobs or env read, beside GITHUB_TOKEN. */
function secretsRead(source) {
  const { env, jobs } = parseYaml(source);
  const text = JSON.stringify({ env, jobs });
  const names = [...text.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/gu)].map(([, name]) => name);
  return [...new Set(names)].filter((name) => name !== 'GITHUB_TOKEN').sort();
}

function assertSecrets(source, sources) {
  for (const { file, id, job } of callsOf(source)) {
    const where = `${NIGHTLY} › ${id}`;
    assert.notEqual(
      job.secrets,
      'inherit',
      `${where} must pass its secrets by name, never inherit`
    );
    const declared = Object.keys(
      parseYaml(sources.get(file)).on?.workflow_call?.secrets ?? {}
    ).sort();
    assert.deepEqual(
      declared,
      secretsRead(sources.get(file)),
      `${file} must declare exactly the secrets it reads: a called workflow sees only those`
    );
    assert.deepEqual(
      job.secrets,
      Object.fromEntries(declared.map((name) => [name, actions(`secrets.${name}`)])),
      `${where} must pass each secret ${file} declares, by name`
    );
  }
}

/** The widest level of each scope a workflow and every workflow it calls ask for. */
function requiredPermissions(file, sources) {
  const workflow = parseYaml(sources.get(file));
  const needed = {};
  const ask = (permissions, where) => {
    if (permissions === undefined) {
      return;
    }
    assert.equal(typeof permissions, 'object', `${where} must list its permissions by scope`);
    for (const [scope, level] of Object.entries(permissions)) {
      assert.ok(level in LEVEL, `${where} › ${scope} has the unknown level ${level}`);
      if (LEVEL[level] > LEVEL[needed[scope] ?? 'none']) {
        needed[scope] = level;
      }
    }
  };
  ask(workflow.permissions, file);
  for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
    ask(job.permissions, `${file} › ${id}`);
  }
  for (const { file: callee, id } of callsOf(sources.get(file))) {
    ask(requiredPermissions(callee, sources), `${file} › ${id} › ${callee}`);
  }
  return needed;
}

function assertPermissions(source, sources) {
  assert.deepEqual(
    parseYaml(source).permissions,
    {},
    `${NIGHTLY} grants nothing by default: each call grants its own`
  );
  for (const { file, id, job } of callsOf(source)) {
    assert.deepEqual(
      job.permissions,
      requiredPermissions(file, sources),
      `${NIGHTLY} › ${id} must grant exactly what ${file} and the workflows it calls ask for`
    );
  }
}

function assertConcurrency(source, sources) {
  assert.deepEqual(
    parseYaml(source).concurrency,
    {
      'cancel-in-progress': false,
      group: `${actions('github.workflow')}-${actions('github.ref')}`,
    },
    `${NIGHTLY} runs one night per ref at a time and never cancels one`
  );
  for (const file of NIGHTLY_CALLS) {
    const group = String(parseYaml(sources.get(file)).concurrency?.group ?? '');
    const prefix = `${actions('github.workflow')}-${stem(file)}-`;
    assert.ok(
      group.startsWith(prefix),
      `${file}'s concurrency group must start "${prefix}": in a called run github.workflow is ${NIGHTLY}'s name, so only the file's own name keeps its group apart from ${NIGHTLY}'s and its siblings'`
    );
  }
}

/** The levels of the call tree under `file`, and every reusable workflow in it. */
function callTree(file, sources, chain = [file]) {
  const files = new Set();
  let levels = chain.length;
  for (const { file: callee } of callsOf(sources.get(file))) {
    assert.ok(!chain.includes(callee), `${[...chain, callee].join(' > ')} is a loop`);
    files.add(callee);
    const nested = callTree(callee, sources, [...chain, callee]);
    levels = Math.max(levels, nested.levels);
    for (const nestedFile of nested.files) {
      files.add(nestedFile);
    }
  }
  return { files, levels };
}

function assertLimits(sources) {
  const { files, levels } = callTree(NIGHTLY, sources);
  assert.ok(levels <= MAX_LEVELS, `${NIGHTLY} connects ${levels} levels; GitHub allows ten`);
  assert.ok(
    files.size <= MAX_UNIQUE_REUSABLE,
    `${NIGHTLY} calls ${files.size} unique reusable workflows; GitHub allows 50`
  );
}

function artifactSteps(source, action) {
  return Object.entries(parseYaml(source).jobs ?? {}).flatMap(([id, job]) =>
    (job.steps ?? [])
      .filter((step) => String(step.uses ?? '').startsWith(`actions/${action}@`))
      .map((step) => ({ id, step }))
  );
}

/** An artifact name with each expression as a concrete value, and as a wildcard. */
const asName = (name) => String(name).replace(EXPRESSION, 'x');
const asGlob = (name) => String(name).replace(EXPRESSION, '*');

/**
 * One run holds every called workflow's artifacts, so no two workflows'
 * uploads may share a name and no download may reach another workflow's.
 * Notify Linear's results pattern is computed per workflow at run time; the
 * next check proves it against the real workflows.
 */
function assertArtifactNamespace(sources) {
  const tree = [NIGHTLY, ...callTree(NIGHTLY, sources).files];
  const uploads = tree.flatMap((file) =>
    artifactSteps(sources.get(file), 'upload-artifact').map(({ id, step }) => ({
      file,
      id,
      name: step.with?.name,
    }))
  );
  for (const upload of uploads) {
    assert.ok(upload.name, `${upload.file} › ${upload.id} must name its artifact`);
    for (const other of uploads.filter(({ file }) => file !== upload.file)) {
      assert.ok(
        !path.matchesGlob(asName(other.name), asGlob(upload.name)),
        `${upload.file} › ${upload.id} uploads ${upload.name}, which collides with ${other.file} › ${other.id}'s ${other.name} in one nightly run`
      );
    }
  }
  for (const file of tree) {
    for (const { id, step } of artifactSteps(sources.get(file), 'download-artifact')) {
      const selector = step.with?.name ?? step.with?.pattern;
      assert.ok(selector, `${file} › ${id} must name what it downloads`);
      if (selector === RESULTS_PATTERN) {
        continue;
      }
      for (const other of uploads.filter((upload) => upload.file !== file)) {
        assert.ok(
          !path.matchesGlob(asName(other.name), asGlob(selector)),
          `${file} › ${id} downloads ${selector}, which reaches ${other.file}'s ${other.name} in the same nightly run`
        );
      }
    }
  }
}

/** The jobs a workflow's Notify Linear reports, as its `results` input names them. */
function reportedJobs(source) {
  const results = String(parseYaml(source).jobs['notify-linear']?.with?.results ?? '');
  return results.split(',').map((entry) => entry.slice(0, entry.indexOf('=')));
}

/** Each workflow's Notify Linear downloads its own results artifacts, and no sibling's. */
function assertResultsStayHome(sources) {
  const results = NIGHTLY_CALLS.flatMap((file) =>
    artifactSteps(sources.get(file), 'upload-artifact')
      .filter(({ step }) => String(step.with?.name).startsWith('nightly-results--'))
      .map(({ step }) => ({ file, name: asName(step.with.name) }))
  );
  for (const file of NIGHTLY_CALLS) {
    const pattern = resultsArtifactPattern(reportedJobs(sources.get(file)));
    for (const artifact of results) {
      assert.equal(
        path.matchesGlob(artifact.name, pattern),
        artifact.file === file,
        `${file}'s Notify Linear (${pattern}) ${artifact.file === file ? 'misses' : 'reaches'} ${artifact.file}'s ${artifact.name}`
      );
    }
  }
}

/** What in a workflow runs a fix agent: a call, the action, or its credential. */
function fixAgentsIn(source) {
  const { jobs = {}, on } = parseYaml(source);
  const found = [];
  for (const [id, job] of Object.entries(jobs)) {
    if (String(job.uses ?? '').endsWith('/nightly-fix-agent.yml')) {
      found.push(`${id} calls nightly-fix-agent.yml`);
    }
    for (const step of job.steps ?? []) {
      if (String(step.uses ?? '').startsWith('anthropics/claude-code-action@')) {
        found.push(`${id} runs claude-code-action`);
      }
    }
  }
  if (JSON.stringify({ jobs, secrets: on?.workflow_call?.secrets }).includes('CLAUDE_CODE_OAUTH')) {
    found.push('it takes CLAUDE_CODE_OAUTH_TOKEN');
  }
  return found;
}

/** Nothing in the night's call tree runs a fix agent, so only tests decide its verdict. */
function assertNightRunsOnlyTests(sources) {
  for (const file of [NIGHTLY, ...callTree(NIGHTLY, sources).files]) {
    assert.deepEqual(
      fixAgentsIn(sources.get(file)),
      [],
      `${file} runs a fix agent inside the night, so the agent's failure would fail the run a release resolves; nightly-fix.yml runs the agents after the night`
    );
  }
}

function judgeStep(source) {
  const step = parseYaml(source).jobs[VERDICT]?.steps?.find(({ name }) => name === JUDGE_STEP);
  assert.ok(step, `${NIGHTLY} › ${VERDICT} must have a "${JUDGE_STEP}" step`);
  return step;
}

function assertVerdict(source) {
  const { jobs } = parseYaml(source);
  const calls = callsOf(source)
    .map(({ id }) => id)
    .sort();
  assert.deepEqual(
    Object.keys(jobs).sort(),
    [...calls, VERDICT].sort(),
    `${NIGHTLY} runs only its calls and the verdict`
  );
  const verdict = jobs[VERDICT];
  assert.equal(
    verdict.if,
    `${FORK_GUARD} && always()`,
    'the verdict judges every night, red ones too'
  );
  assert.deepEqual([verdict.needs ?? []].flat().sort(), calls, 'the verdict waits for every call');
  const judged = Object.fromEntries(
    Object.entries(judgeStep(source).env ?? {}).filter(([name]) => name.startsWith('RESULT_'))
  );
  assert.deepEqual(
    judged,
    Object.fromEntries(calls.map((id) => [resultEnv(id), actions(`needs.${id}.result`)])),
    'the verdict judges each call by its result'
  );
}

/** Runs the verdict's script with every call successful unless overridden. */
function runJudge(source, overrides = {}) {
  const step = judgeStep(source);
  const results = Object.fromEntries(
    Object.keys(step.env)
      .filter((name) => name.startsWith('RESULT_'))
      .map((name) => [name, 'success'])
  );
  return spawnSync('bash', ['-c', step.run], {
    encoding: 'utf8',
    env: { GITHUB_STEP_SUMMARY: '/dev/null', PATH: process.env.PATH, ...results, ...overrides },
  });
}

test('nightly.yml calls each of the six required nightlies in full, all at once', () => {
  assertCalls(readWorkflow(NIGHTLY), allWorkflows());
});

test('each call passes its workflow’s secrets by name, never inherit', () => {
  assertSecrets(readWorkflow(NIGHTLY), allWorkflows());
});

test('each call grants what its workflow tree asks for, and nothing by default', () => {
  assertPermissions(readWorkflow(NIGHTLY), allWorkflows());
});

test('no called workflow shares a concurrency group with nightly.yml or a sibling', () => {
  assertConcurrency(readWorkflow(NIGHTLY), allWorkflows());
});

test('the call tree stays within GitHub’s nesting and reusable-workflow limits', () => {
  assertLimits(allWorkflows());
});

test('no two workflows of one nightly run share an artifact name or a download', () => {
  assertArtifactNamespace(allWorkflows());
});

test('each workflow’s Notify Linear reads its own test results, never a sibling’s', () => {
  assertResultsStayHome(allWorkflows());
});

test('no workflow of the night runs a fix agent, so only tests decide its verdict', () => {
  assertNightRunsOnlyTests(allWorkflows());
});

test('the verdict waits for every call and judges each result', () => {
  assertVerdict(readWorkflow(NIGHTLY));
});

test('the verdict passes only when every call succeeded', () => {
  const source = readWorkflow(NIGHTLY);
  const green = runJudge(source);
  assert.equal(green.status, 0, green.stdout + green.stderr);
  for (const name of Object.keys(judgeStep(source).env).filter((n) => n.startsWith('RESULT_'))) {
    for (const result of ['failure', 'cancelled', 'skipped', '']) {
      const red = runJudge(source, { [name]: result });
      assert.notEqual(red.status, 0, `${name}=${result}`);
      assert.match(red.stdout, /::error::/u, `${name}=${result} must say which call`);
    }
  }
});

function mutate(source, from, to) {
  const mutated = source.replace(from, to);
  assert.notEqual(mutated, source, `control mutation ${String(from)} matched nothing`);
  return mutated;
}

const withFile = (file, source) => new Map([...allWorkflows(), [file, source]]);

test('CONTROL: dropping a call, or adding needs or inputs, fails the call check', () => {
  const source = readWorkflow(NIGHTLY);
  const dropped = mutate(source, /\n {2}web-e2e:\n[\s\S]*?\n\n/u, '\n');
  assert.throws(() => assertCalls(dropped, allWorkflows()), /exactly the six/u);
  const sequenced = mutate(source, /\n {2}web-e2e:\n/u, '\n  web-e2e:\n    needs: [test]\n');
  assert.throws(() => assertCalls(sequenced, allWorkflows()), /starts with the other calls/u);
  const partial = mutate(source, 'suite: full', 'suite: foreground-latency');
  assert.throws(() => assertCalls(partial, allWorkflows()), /in full/u);
});

test('CONTROL: an inherited, missing or undeclared secret fails the secrets check', () => {
  const source = readWorkflow(NIGHTLY);
  const inherited = mutate(
    source,
    /(\n {2}web-e2e:\n[\s\S]*?)secrets:\n(?: {6}.*\n)+/u,
    '$1secrets: inherit\n'
  );
  assert.throws(() => assertSecrets(inherited, allWorkflows()), /never inherit/u);
  const missing = mutate(
    source,
    /(\n {2}web-e2e:\n[\s\S]*?secrets:\n) {6}LINEAR_API_KEY: .*\n/u,
    '$1'
  );
  assert.throws(() => assertSecrets(missing, allWorkflows()), /must pass each secret/u);
  const undeclared = mutate(
    readWorkflow('web-e2e.yml'),
    /\n {6}LINEAR_API_KEY:\n {8}required: true\n/u,
    '\n'
  );
  assert.throws(
    () => assertSecrets(source, withFile('web-e2e.yml', undeclared)),
    /declare exactly the secrets it reads/u
  );
});

test('CONTROL: a call granting less than its tree asks for fails the permissions check', () => {
  const source = readWorkflow(NIGHTLY);
  const narrowed = mutate(source, /(\n {2}test:\n[\s\S]*?) {6}pull-requests: read\n/u, '$1');
  assert.throws(() => assertPermissions(narrowed, allWorkflows()), /test must grant/u);
  const widened = mutate(source, 'permissions: {}', 'permissions:\n  contents: read');
  assert.throws(() => assertPermissions(widened, allWorkflows()), /grants nothing by default/u);
});

test('CONTROL: a called workflow grouped by its caller’s name alone fails the concurrency check', () => {
  const shared = mutate(
    readWorkflow('web-e2e.yml'),
    `group: ${actions('github.workflow')}-web-e2e-`,
    `group: ${actions('github.workflow')}-`
  );
  assert.throws(
    () => assertConcurrency(readWorkflow(NIGHTLY), withFile('web-e2e.yml', shared)),
    /web-e2e\.yml's concurrency group/u
  );
});

test('CONTROL: an eleventh level or a loop fails the limits check', () => {
  const chain = (levels) =>
    new Map(
      Array.from({ length: levels }, (_, index) => [
        index === 0 ? NIGHTLY : `level-${index}.yml`,
        index === levels - 1
          ? 'jobs: {}\n'
          : `jobs:\n  next:\n    uses: ${LOCAL_WORKFLOW}level-${index + 1}.yml\n`,
      ])
    );
  assert.doesNotThrow(() => assertLimits(chain(MAX_LEVELS)));
  assert.throws(() => assertLimits(chain(MAX_LEVELS + 1)), /11 levels/u);
  const loop = new Map([
    [NIGHTLY, `jobs:\n  a:\n    uses: ${LOCAL_WORKFLOW}a.yml\n`],
    ['a.yml', `jobs:\n  back:\n    uses: ${LOCAL_WORKFLOW}a.yml\n`],
  ]);
  assert.throws(() => assertLimits(loop), /is a loop/u);
});

test('CONTROL: a colliding upload or a download reaching a sibling fails the namespace check', () => {
  const collides = mutate(
    readWorkflow('performance.yml'),
    'name: perf-blob-report',
    'name: web-full-regression-test-results'
  );
  assert.throws(
    () => assertArtifactNamespace(withFile('performance.yml', collides)),
    /collides with/u
  );
  const reaches = mutate(
    readWorkflow('nightly-coverage.yml'),
    'pattern: nightly-coverage-*',
    'pattern: "*"'
  );
  assert.throws(
    () => assertArtifactNamespace(withFile('nightly-coverage.yml', reaches)),
    /in the same nightly run/u
  );
});

test('CONTROL: a sibling’s results job, or a renamed results artifact, fails the results check', () => {
  const borrowed = mutate(
    readWorkflow('performance.yml'),
    `results: web-perf=${actions('needs.web-perf.result')}`,
    `results: web-perf=${actions('needs.web-perf.result')},web-full-regression=success`
  );
  assert.throws(
    () => assertResultsStayHome(withFile('performance.yml', borrowed)),
    /performance\.yml's Notify Linear .* reaches web-e2e\.yml's/u
  );
  const renamed = mutate(
    readWorkflow('web-e2e.yml'),
    'name: nightly-results--web-full-regression\n',
    'name: nightly-results--web-regression\n'
  );
  assert.throws(
    () => assertResultsStayHome(withFile('web-e2e.yml', renamed)),
    /web-e2e\.yml's Notify Linear .* misses/u
  );
});

// BST-2189's inline fix job, as desktop-e2e.yml ran it before BST-2235.
const INLINE_FIX_JOB = `
  fix-nightly:
    name: Fix nightly test
    needs: [notify-linear]
    if: ${actions(`${FORK_GUARD} && needs.notify-linear.outputs.fix_issues != '[]'`)}
    strategy:
      fail-fast: false
      matrix:
        issue: ${actions('fromJSON(needs.notify-linear.outputs.fix_issues)')}
    uses: ./.github/workflows/nightly-fix-agent.yml
    with:
      issue: ${actions('matrix.issue')}
      runs_on: ubuntu-latest
`;

test('CONTROL: a fix agent back inside a workflow of the night fails the only-tests check', () => {
  const inline = `${readWorkflow('desktop-e2e.yml')}${INLINE_FIX_JOB}`;
  assert.throws(
    () => assertNightRunsOnlyTests(withFile('desktop-e2e.yml', inline)),
    /desktop-e2e\.yml runs a fix agent inside the night/u
  );
  const action = mutate(
    readWorkflow('web-e2e.yml'),
    /(\n {4}steps:\n)/u,
    '$1      - uses: anthropics/claude-code-action@v1\n'
  );
  assert.throws(
    () => assertNightRunsOnlyTests(withFile('web-e2e.yml', action)),
    /web-e2e\.yml runs a fix agent inside the night/u
  );
});

test('CONTROL: a verdict that skips a call or judges the wrong result fails the verdict check', () => {
  const source = readWorkflow(NIGHTLY);
  const unwaited = mutate(source, ' desktop-e2e, web-e2e, native', ' desktop-e2e, native');
  assert.throws(() => assertVerdict(unwaited), /waits for every call/u);
  const unjudged = mutate(source, /\n {10}RESULT_WEB_E2E: .*\n/u, '\n');
  assert.throws(() => assertVerdict(unjudged), /judges each call/u);
  const ungated = mutate(source, `${FORK_GUARD} && always()`, FORK_GUARD);
  assert.throws(() => assertVerdict(ungated), /red ones too/u);
});
