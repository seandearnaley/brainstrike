/**
 * BST-2190: a release builds only from a commit on which every required
 * nightly workflow passed. The required set lives in one module,
 * scripts/release-required-workflows.mjs, which the resolver imports.
 *
 * The rule (scripts/resolve-release-sha.mjs): a SHA is green when, for every
 * required workflow, the latest COMPLETED run with event=schedule on that
 * head_sha concluded success. A run in progress, or no scheduled run at all,
 * counts as missing. The decision is a pure function over run records; the
 * CLI tests run the real script against a local fake of the REST API.
 *
 * BST-2233 (owner decision 2026-10-19): the six owner-named workflows run as
 * one scheduled run of nightly.yml, so the required set is that one workflow.
 * Its run succeeds only when every call succeeded, so a SHA is green only when
 * that night's run did.
 *
 * Each check is a function over its inputs, so the CONTROL tests can feed it a
 * broken set or workflow and watch it fail.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { REQUIRED_NIGHTLY_WORKFLOWS } from '../release-required-workflows.mjs';
import { judgeSha, newestGreenSha } from '../resolve-release-sha.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const resolverScript = path.join(repoRoot, 'scripts', 'resolve-release-sha.mjs');
const workflowPath = (file) => path.join(repoRoot, '.github', 'workflows', file);
const readWorkflow = (file) =>
  existsSync(workflowPath(file)) ? readFileSync(workflowPath(file), 'utf8') : undefined;

// The owner's named set (BST-2190), and the one scheduled run that calls it
// (BST-2233). These are the expectations the module is held to, not a second
// definition: nothing but these tests reads them.
const OWNER_NAMED = [
  'desktop-e2e.yml',
  'native-package-matrix.yml',
  'nightly-coverage.yml',
  'performance.yml',
  'test.yml',
  'web-e2e.yml',
];
const NIGHTLY = 'nightly.yml';

function assertRequiredWorkflowsAreScheduled(required, read) {
  assert.ok(required.length > 0, 'the required nightly set must name at least one workflow');
  for (const file of required) {
    const source = read(file);
    assert.ok(
      source !== undefined,
      `${file} is required for a release, but .github/workflows/${file} does not exist`
    );
    const schedule = parseYaml(source).on?.schedule;
    assert.ok(
      Array.isArray(schedule) && schedule.length > 0,
      `${file} is required for a release, but it has no schedule trigger`
    );
  }
}

/** The required set is the one scheduled run that calls each owner-named workflow. */
function assertRequiredNightlyCallsTheSix(required, read) {
  assert.deepEqual([...required], [NIGHTLY], `a release must judge ${NIGHTLY}'s scheduled run`);
  const called = Object.values(parseYaml(read(NIGHTLY)).jobs)
    .map((job) => String(job.uses ?? ''))
    .filter((uses) => uses.startsWith('./.github/workflows/'))
    .map((uses) => path.basename(uses))
    .sort();
  assert.deepEqual(called, OWNER_NAMED, `${NIGHTLY} must call each owner-named workflow`);
}

test('the required nightly is the one scheduled run that calls the owner-named six', () => {
  assertRequiredNightlyCallsTheSix(REQUIRED_NIGHTLY_WORKFLOWS, readWorkflow);
});

test('every required nightly workflow exists and runs on a schedule', () => {
  assertRequiredWorkflowsAreScheduled(REQUIRED_NIGHTLY_WORKFLOWS, readWorkflow);
});

test('CONTROL: the six judged one by one, or a caller missing one, fails the contract', () => {
  assert.throws(
    () => assertRequiredNightlyCallsTheSix(OWNER_NAMED, readWorkflow),
    /must judge nightly\.yml's scheduled run/u
  );
  const short = readWorkflow(NIGHTLY).replace('uses: ./.github/workflows/web-e2e.yml', '');
  assert.notEqual(short, readWorkflow(NIGHTLY), 'control mutation matched nothing');
  assert.throws(
    () => assertRequiredNightlyCallsTheSix([NIGHTLY], () => short),
    /must call each owner-named workflow/u
  );
});

test('CONTROL: a missing or unscheduled required workflow fails the contract', () => {
  assert.throws(
    () => assertRequiredWorkflowsAreScheduled(['no-such-nightly.yml'], readWorkflow),
    /no-such-nightly\.yml does not exist/u
  );
  const unscheduled = readWorkflow(NIGHTLY).replace(/\n {2}schedule:\n(?: {4}.*\n)+/u, '\n');
  assert.notEqual(unscheduled, readWorkflow(NIGHTLY), 'control mutation matched nothing');
  assert.throws(
    () => assertRequiredWorkflowsAreScheduled([NIGHTLY], () => unscheduled),
    /nightly\.yml is required for a release, but it has no schedule trigger/u
  );
});

const SHA = { middle: 'b'.repeat(40), newest: 'c'.repeat(40), oldest: 'a'.repeat(40) };
const NIGHT = {
  first: '2026-10-17T07:30:00Z',
  second: '2026-10-18T07:30:00Z',
  third: '2026-10-19T07:30:00Z',
};
let nextRunId = 1000;

/** One workflow run record, shaped like the REST API's `workflow_runs` items. */
function run(sha, overrides = {}) {
  nextRunId += 1;
  return {
    conclusion: 'success',
    created_at: NIGHT.third,
    event: 'schedule',
    head_branch: 'main',
    head_sha: sha,
    html_url: `https://github.com/o/r/actions/runs/${nextRunId}`,
    id: nextRunId,
    run_number: nextRunId,
    status: 'completed',
    ...overrides,
  };
}

/** One night: nightly.yml's scheduled run on `sha`, unless `changes` says otherwise. */
function night(sha, createdAt, changes = {}) {
  return Object.fromEntries(
    REQUIRED_NIGHTLY_WORKFLOWS.map((workflow) => [
      workflow,
      changes[workflow] ?? [run(sha, { created_at: createdAt })],
    ])
  );
}

/** Merges nights into one runs-by-workflow record, as the API lists them. */
function nights(...list) {
  return Object.fromEntries(
    REQUIRED_NIGHTLY_WORKFLOWS.map((workflow) => [
      workflow,
      list.flatMap((entry) => entry[workflow] ?? []),
    ])
  );
}

const stateOf = (verdict, workflow) =>
  verdict.workflows.find((entry) => entry.workflow === workflow)?.state;

test('a SHA whose nightly run passed is green', () => {
  const verdict = judgeSha(SHA.newest, night(SHA.newest, NIGHT.third));
  assert.equal(verdict.green, true);
  assert.deepEqual(
    verdict.workflows.map((entry) => [entry.workflow, entry.state]),
    [[NIGHTLY, 'success']]
  );
});

test('a red, missing or in-progress nightly run excludes its SHA', () => {
  for (const [label, runs, state] of [
    ['red', [run(SHA.newest, { conclusion: 'failure' })], 'failure'],
    ['cancelled', [run(SHA.newest, { conclusion: 'cancelled' })], 'cancelled'],
    ['missing', [], 'missing'],
    ['in progress', [run(SHA.newest, { conclusion: null, status: 'in_progress' })], 'missing'],
  ]) {
    const verdict = judgeSha(SHA.newest, night(SHA.newest, NIGHT.third, { [NIGHTLY]: runs }));
    assert.equal(verdict.green, false, `a ${label} nightly run must exclude the SHA`);
    assert.equal(stateOf(verdict, NIGHTLY), state, label);
  }
});

test('the six workflows’ own runs never make a SHA green: only the nightly run counts', () => {
  const ownRuns = Object.fromEntries(OWNER_NAMED.map((workflow) => [workflow, [run(SHA.newest)]]));
  const verdict = judgeSha(SHA.newest, { ...ownRuns, [NIGHTLY]: [] });
  assert.equal(verdict.green, false);
  assert.equal(stateOf(verdict, NIGHTLY), 'missing');
});

test('only scheduled runs on that exact SHA count', () => {
  const dispatched = night(SHA.newest, NIGHT.third, {
    [NIGHTLY]: [run(SHA.newest, { event: 'workflow_dispatch' })],
  });
  assert.equal(stateOf(judgeSha(SHA.newest, dispatched), NIGHTLY), 'missing');
  const elsewhere = night(SHA.newest, NIGHT.third, { [NIGHTLY]: [run(SHA.oldest)] });
  assert.equal(stateOf(judgeSha(SHA.newest, elsewhere), NIGHTLY), 'missing');
});

test('the latest completed scheduled run on a SHA decides it', () => {
  const passedThenFailed = night(SHA.newest, NIGHT.third, {
    [NIGHTLY]: [
      run(SHA.newest, { created_at: NIGHT.second }),
      run(SHA.newest, { conclusion: 'failure' }),
    ],
  });
  assert.equal(judgeSha(SHA.newest, passedThenFailed).green, false);
  const failedThenPassed = night(SHA.newest, NIGHT.third, {
    [NIGHTLY]: [
      run(SHA.newest, { conclusion: 'failure', created_at: NIGHT.second }),
      run(SHA.newest),
    ],
  });
  assert.equal(judgeSha(SHA.newest, failedThenPassed).green, true);
  const passedThenRunning = night(SHA.newest, NIGHT.third, {
    [NIGHTLY]: [
      run(SHA.newest, { created_at: NIGHT.second }),
      run(SHA.newest, { conclusion: null, status: 'in_progress' }),
    ],
  });
  assert.equal(judgeSha(SHA.newest, passedThenRunning).green, true);
});

test('the newest all-green SHA is chosen', () => {
  const runs = nights(
    night(SHA.oldest, NIGHT.first),
    night(SHA.middle, NIGHT.second),
    night(SHA.newest, NIGHT.third, {
      [NIGHTLY]: [run(SHA.newest, { conclusion: 'failure' })],
    })
  );
  const { chosen, judged } = newestGreenSha(runs);
  assert.equal(chosen?.sha, SHA.middle);
  assert.deepEqual(
    judged.map((verdict) => [verdict.sha, verdict.green]),
    [
      [SHA.newest, false],
      [SHA.middle, true],
    ],
    'judging stops at the newest green SHA'
  );
});

test('with no green nightly run, no SHA is chosen', () => {
  const runs = nights(
    night(SHA.middle, NIGHT.second, { [NIGHTLY]: [run(SHA.middle, { conclusion: 'failure' })] }),
    night(SHA.newest, NIGHT.third, { [NIGHTLY]: [run(SHA.newest, { conclusion: 'cancelled' })] })
  );
  const { chosen, judged } = newestGreenSha(runs);
  assert.equal(chosen, undefined);
  assert.deepEqual(
    judged.map((verdict) => verdict.green),
    [false, false]
  );
});

// --- The CLI against a local fake of the GitHub REST API ---------------------

const execFileAsync = promisify(execFile);
const TOKEN = 'fake-token-for-a-local-stub';
const PAGE_SIZE = 2;

/**
 * Serves `GET /repos/o/r/commits/{ref}` from `commits` and
 * `GET /repos/o/r/actions/workflows/{file}/runs` from `runs`, applying the
 * event/head_sha/branch filters and paging by PAGE_SIZE through Link headers,
 * then runs the real resolver script against it.
 */
async function runResolver(args, { commits = {}, runs = {} }) {
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push(url);
    const send = (status, body, headers = {}) => {
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(JSON.stringify(body));
    };
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      send(401, { message: 'Bad credentials' });
      return;
    }
    const commit = /^\/repos\/o\/r\/commits\/(.+)$/u.exec(url.pathname);
    if (commit) {
      const sha = commits[decodeURIComponent(commit[1])];
      send(sha ? 200 : 422, sha ? { sha } : { message: 'No commit found' });
      return;
    }
    const listing = /^\/repos\/o\/r\/actions\/workflows\/([^/]+)\/runs$/u.exec(url.pathname);
    if (!listing) {
      send(404, { message: 'Not Found' });
      return;
    }
    const query = Object.fromEntries(url.searchParams);
    const matching = (runs[decodeURIComponent(listing[1])] ?? []).filter(
      (candidate) =>
        (query.event === undefined || candidate.event === query.event) &&
        (query.head_sha === undefined || candidate.head_sha === query.head_sha) &&
        (query.branch === undefined || candidate.head_branch === query.branch)
    );
    const page = Number(query.page ?? '1');
    const headers = {};
    if (page * PAGE_SIZE < matching.length) {
      const next = new URL(url);
      next.searchParams.set('page', String(page + 1));
      headers.link = `<http://127.0.0.1:${server.address().port}${next.pathname}${next.search}>; rel="next"`;
    }
    send(
      200,
      {
        total_count: matching.length,
        workflow_runs: matching.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
      },
      headers
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const env = {
      GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_TOKEN: TOKEN,
      PATH: process.env.PATH,
    };
    try {
      const { stderr, stdout } = await execFileAsync(process.execPath, [resolverScript, ...args], {
        env,
      });
      return { requests, status: 0, stderr, stdout };
    } catch (error) {
      return { requests, status: error.code, stderr: error.stderr, stdout: error.stdout };
    }
  } finally {
    server.close();
  }
}

const runListings = (requests) =>
  requests.filter((url) => url.pathname.endsWith('/runs')).map((url) => url.searchParams);

test('a given red SHA refuses and says why its nightly run is not green', async () => {
  for (const [runs, reason] of [
    [[run(SHA.newest, { conclusion: 'failure' })], /failure \(https:\/\/github\.com/u],
    [[], /missing \(no scheduled run on this SHA\)/u],
    [
      [run(SHA.newest, { conclusion: null, status: 'in_progress' })],
      /missing \(1 scheduled run still in progress\)/u,
    ],
  ]) {
    const result = await runResolver(['--given', SHA.newest], {
      commits: { [SHA.newest]: SHA.newest },
      runs: night(SHA.newest, NIGHT.third, { [NIGHTLY]: runs }),
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '', 'a refusal resolves no SHA');
    assert.match(result.stderr, /Refusing to release c{40}: 1 of 1 required nightly workflows/u);
    assert.match(result.stderr, new RegExp(`::error::nightly\\.yml: ${reason.source}`, 'u'));
    const listings = result.requests.filter((url) => url.pathname.endsWith('/runs'));
    assert.deepEqual(
      [...new Set(listings.map((url) => url.pathname))],
      ['/repos/o/r/actions/workflows/nightly.yml/runs'],
      'the resolver reads only the nightly run, never the six workflows one by one'
    );
    for (const params of runListings(result.requests)) {
      assert.equal(params.get('event'), 'schedule');
      assert.equal(params.get('head_sha'), SHA.newest);
    }
  }
});

test('a given green SHA resolves, reading every page of its runs', async () => {
  const runs = nights(
    night(SHA.newest, NIGHT.first),
    night(SHA.newest, NIGHT.second),
    night(SHA.newest, NIGHT.third)
  );
  const result = await runResolver(['--given', SHA.newest], {
    commits: { [SHA.newest]: SHA.newest },
    runs,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `sha=${SHA.newest}\n`);
  assert.deepEqual(
    [...new Set(runListings(result.requests).map((params) => params.get('page') ?? '1'))].sort(),
    ['1', '2'],
    "three runs per workflow at two per page needs the Link header's second page"
  );
});

test('a pushed tag is judged as the given commit it points to', async () => {
  const tag = 'refs/tags/v1.2.3';
  const red = night(SHA.middle, NIGHT.third, {
    [NIGHTLY]: [run(SHA.middle, { conclusion: 'cancelled' })],
  });
  const refused = await runResolver(['--given', tag], {
    commits: { 'tags/v1.2.3': SHA.middle },
    runs: nights(night(SHA.oldest, NIGHT.first), red),
  });
  assert.equal(refused.status, 1, 'a tag on a red commit refuses, with no other SHA chosen');
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /Refusing to release b{40}/u);
  assert.match(refused.stderr, /::error::nightly\.yml: cancelled/u);
  const green = await runResolver(['--given', tag], {
    commits: { 'tags/v1.2.3': SHA.middle },
    runs: night(SHA.middle, NIGHT.third),
  });
  assert.equal(green.stdout, `sha=${SHA.middle}\n`, green.stderr);
});

test('a given commit the repository does not have fails loudly', async () => {
  const result = await runResolver(['--given', SHA.oldest], {
    runs: night(SHA.oldest, NIGHT.third),
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /answered 422/u);
});

test('by default the newest all-green main commit within the lookback is chosen', async () => {
  const runs = nights(
    night(SHA.oldest, NIGHT.first),
    night(SHA.middle, NIGHT.second),
    night(SHA.newest, NIGHT.third, { [NIGHTLY]: [run(SHA.newest, { conclusion: 'failure' })] })
  );
  const result = await runResolver(['--newest-green', '--lookback-days', '14'], { runs });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `sha=${SHA.middle}\n`);
  assert.match(result.stderr, /c{40} is not green: nightly\.yml: failure/u);
  for (const params of runListings(result.requests)) {
    assert.equal(params.get('event'), 'schedule');
    assert.equal(params.get('branch'), 'main');
    assert.match(params.get('created'), /^>=\d{4}-\d{2}-\d{2}T/u);
  }
});

test('with no all-green main commit in the lookback the default fails and says how far back it searched', async () => {
  const runs = nights(
    night(SHA.middle, NIGHT.second, { [NIGHTLY]: [run(SHA.middle, { conclusion: 'failure' })] }),
    night(SHA.newest, NIGHT.third, {
      [NIGHTLY]: [run(SHA.newest, { conclusion: null, status: 'in_progress' })],
    })
  );
  const result = await runResolver(['--newest-green', '--lookback-days', '14'], { runs });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(
    result.stderr,
    /::error::No main commit has every required nightly green in the last 14 days \(scheduled runs created since \d{4}-\d{2}-\d{2}T[^)]*\); judged 2 commits/u
  );
  assert.match(result.stderr, /c{40} is not green: nightly\.yml: missing/u);
  assert.match(result.stderr, /b{40} is not green: nightly\.yml: failure/u);
});

test('an unknown mode or a missing token is refused before any request', async () => {
  const usage = await runResolver(['--given', 'main'], {});
  assert.equal(usage.status, 2);
  assert.deepEqual(usage.requests, []);
  const noLookback = await runResolver(['--newest-green'], {});
  assert.equal(noLookback.status, 2);
  const tokenless = await execFileAsync(process.execPath, [resolverScript, '--given', SHA.newest], {
    env: { GITHUB_API_URL: 'http://127.0.0.1:9', GITHUB_REPOSITORY: 'o/r', PATH: process.env.PATH },
  }).catch((error) => error);
  assert.equal(tokenless.code, 2);
  assert.match(tokenless.stderr, /GITHUB_TOKEN is required/u);
});

test('run through a symlink, the resolver still runs rather than silently doing nothing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'resolve-release-sha-'));
  try {
    symlinkSync(path.join(repoRoot, 'scripts'), path.join(dir, 'scripts'));
    const linked = await execFileAsync(process.execPath, [
      path.join(dir, 'scripts', 'resolve-release-sha.mjs'),
    ]).catch((error) => error);
    assert.equal(linked.code, 2, 'an entry check that missed would exit 0 with no SHA');
    assert.match(linked.stderr, /usage: resolve-release-sha\.mjs/u);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
