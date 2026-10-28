#!/usr/bin/env node
// Resolves the commit a desktop release builds (BST-2190,
// .github/workflows/release.yml): only a commit on which every required
// nightly workflow (scripts/release-required-workflows.mjs) passed.
//
// The rule: a SHA is green when, for every required workflow, the latest
// COMPLETED run with event=schedule on that head_sha concluded `success`. A
// rerun counts, because a run's conclusion is its latest attempt's. A run in
// progress, or no scheduled run at all, counts as missing.
//
// Usage:
//   resolve-release-sha.mjs --given <40-hex sha | refs/tags/<tag>>
//     Judges that commit (a tag is resolved to the commit it points to). If any
//     required workflow is red or missing, it refuses and names each one; it
//     never picks another SHA.
//   resolve-release-sha.mjs --newest-green --lookback-days <n>
//     Chooses the newest main commit that is green among the scheduled runs of
//     the last <n> days, or fails and says how far back it searched.
//
// Reads the Actions REST API with GITHUB_TOKEN at GITHUB_API_URL for
// GITHUB_REPOSITORY (all three are required). On success prints `sha=<sha>`
// on stdout, for $GITHUB_OUTPUT; the verdict goes to stderr. Exits 1 on a
// refusal or an API failure, 2 on a usage error.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { REQUIRED_NIGHTLY_WORKFLOWS } from './release-required-workflows.mjs';

const MAIN = 'main';
const FULL_SHA = /^[0-9a-f]{40}$/u;
const TAG_REF = /^refs\/tags\/(.+)$/u;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {{ conclusion: string | null, created_at: string, event: string,
 *   head_branch: string | null, head_sha: string, html_url: string,
 *   run_number: number, status: string | null }} WorkflowRun
 * @typedef {{ workflow: string, state: string, detail: string }} WorkflowVerdict
 * @typedef {{ sha: string, green: boolean, workflows: WorkflowVerdict[] }} ShaVerdict
 */

/**
 * @param {string} sha
 * @param {Record<string, WorkflowRun[]>} runsByWorkflow
 * @returns {ShaVerdict}
 */
export function judgeSha(sha, runsByWorkflow) {
  const workflows = REQUIRED_NIGHTLY_WORKFLOWS.map((workflow) => {
    const scheduled = (runsByWorkflow[workflow] ?? []).filter(
      (run) => run.event === 'schedule' && run.head_sha === sha
    );
    const latest = scheduled
      .filter((run) => run.status === 'completed')
      .sort((a, b) => b.run_number - a.run_number)[0];
    if (latest === undefined) {
      const running = scheduled.length;
      const detail =
        running === 0
          ? 'no scheduled run on this SHA'
          : `${running} scheduled run${running === 1 ? '' : 's'} still in progress`;
      return { detail, state: 'missing', workflow };
    }
    return { detail: latest.html_url, state: latest.conclusion ?? 'no conclusion', workflow };
  });
  return { green: workflows.every(({ state }) => state === 'success'), sha, workflows };
}

/**
 * Judges main's scheduled SHAs newest first and stops at the first green one.
 * A scheduled run runs on the default branch's head when it starts, and main's
 * ruleset blocks non-fast-forward pushes, so ordering SHAs by their newest
 * scheduled run orders them by main's history.
 * @param {Record<string, WorkflowRun[]>} runsByWorkflow
 * @returns {{ chosen: ShaVerdict | undefined, judged: ShaVerdict[] }}
 */
export function newestGreenSha(runsByWorkflow) {
  const newestRun = new Map();
  for (const workflow of REQUIRED_NIGHTLY_WORKFLOWS) {
    for (const run of runsByWorkflow[workflow] ?? []) {
      if (run.event === 'schedule' && run.head_branch === MAIN) {
        const created = Date.parse(run.created_at);
        newestRun.set(run.head_sha, Math.max(newestRun.get(run.head_sha) ?? created, created));
      }
    }
  }
  const judged = [];
  for (const [sha] of [...newestRun].sort((a, b) => b[1] - a[1])) {
    const verdict = judgeSha(sha, runsByWorkflow);
    judged.push(verdict);
    if (verdict.green) {
      return { chosen: verdict, judged };
    }
  }
  return { chosen: undefined, judged };
}

const notGreen = (verdict) => verdict.workflows.filter(({ state }) => state !== 'success');
const describe = ({ detail, state, workflow }) => `${workflow}: ${state} (${detail})`;

class UsageError extends Error {}

function readEnv(env) {
  for (const name of ['GITHUB_API_URL', 'GITHUB_REPOSITORY', 'GITHUB_TOKEN']) {
    if (!env[name]) {
      throw new UsageError(`${name} is required`);
    }
  }
  return { base: env.GITHUB_API_URL, repo: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN };
}

async function get(api, url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${api.token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(`GET ${url} answered ${response.status}: ${await response.text()}`);
  }
  return response;
}

/** Every run of `workflow` matching `query`, across all pages. */
async function listRuns(api, workflow, query) {
  const params = new URLSearchParams({ ...query, per_page: '100' });
  let url = `${api.base}/repos/${api.repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?${params}`;
  const runs = [];
  let total = 0;
  while (url) {
    const response = await get(api, url);
    const page = await response.json();
    total = page.total_count;
    runs.push(...page.workflow_runs);
    url = /<([^>]+)>;\s*rel="next"/u.exec(response.headers.get('link') ?? '')?.[1];
  }
  if (runs.length !== total) {
    throw new Error(
      `${workflow}: listed ${runs.length} runs but the API counts ${total}; refusing to judge a partial list`
    );
  }
  return runs;
}

async function listRequiredRuns(api, query) {
  const lists = await Promise.all(
    REQUIRED_NIGHTLY_WORKFLOWS.map((workflow) => listRuns(api, workflow, query))
  );
  return Object.fromEntries(REQUIRED_NIGHTLY_WORKFLOWS.map((workflow, i) => [workflow, lists[i]]));
}

/** Judges the given commit; returns its SHA only when it is green. */
async function resolveGiven(api, given) {
  const tag = TAG_REF.exec(given)?.[1];
  // The full ref: the commits API peels an annotated tag to its commit only
  // for `refs/tags/<tag>`, and answers 422 for `tags/<tag>`.
  const ref = tag === undefined ? given : `refs/tags/${encodeURIComponent(tag)}`;
  const response = await get(api, `${api.base}/repos/${api.repo}/commits/${ref}`);
  const { sha } = await response.json();
  if (!FULL_SHA.test(sha ?? '') || (tag === undefined && sha !== given)) {
    throw new Error(`${given} resolved to commit ${sha}, not to the full SHA given`);
  }
  const verdict = judgeSha(sha, await listRequiredRuns(api, { event: 'schedule', head_sha: sha }));
  const red = notGreen(verdict);
  if (red.length > 0) {
    console.error(
      `::error::Refusing to release ${sha}${tag === undefined ? '' : ` (${given})`}: ` +
        `${red.length} of ${verdict.workflows.length} required nightly workflows are not green on it.`
    );
    for (const entry of red) {
      console.error(`::error::${describe(entry)}`);
    }
    return;
  }
  console.error(`${sha} is green on every required nightly workflow:`);
  for (const entry of verdict.workflows) {
    console.error(`  ${describe(entry)}`);
  }
  return sha;
}

/** Chooses the newest green main commit of the lookback, or returns nothing. */
async function resolveNewestGreen(api, days) {
  const since = new Date(Date.now() - days * DAY_MS).toISOString();
  const runs = await listRequiredRuns(api, {
    branch: MAIN,
    created: `>=${since}`,
    event: 'schedule',
  });
  const { chosen, judged } = newestGreenSha(runs);
  for (const verdict of judged.filter(({ green }) => !green)) {
    console.error(`${verdict.sha} is not green: ${notGreen(verdict).map(describe).join('; ')}`);
  }
  if (chosen === undefined) {
    console.error(
      `::error::No ${MAIN} commit has every required nightly green in the last ${days} days ` +
        `(scheduled runs created since ${since}); judged ${judged.length} commits.`
    );
    return;
  }
  console.error(`Chose ${chosen.sha}, the newest ${MAIN} commit green on every required nightly.`);
  return chosen.sha;
}

const USAGE =
  'usage: resolve-release-sha.mjs --given <40-hex sha | refs/tags/<tag>> | --newest-green --lookback-days <n>';

/** The resolution mode argv names, or a UsageError before any request. */
function parseArgs(argv) {
  const [mode, value, days] = argv;
  if (mode === '--given' && argv.length === 2 && (FULL_SHA.test(value) || TAG_REF.test(value))) {
    return { given: value };
  }
  const lookbackDays = Number(days);
  if (
    mode === '--newest-green' &&
    argv.length === 3 &&
    value === '--lookback-days' &&
    Number.isInteger(lookbackDays) &&
    lookbackDays > 0
  ) {
    return { lookbackDays };
  }
  throw new UsageError(USAGE);
}

async function main(argv, env) {
  const { given, lookbackDays } = parseArgs(argv);
  const api = readEnv(env);
  const sha =
    given === undefined
      ? await resolveNewestGreen(api, lookbackDays)
      : await resolveGiven(api, given);
  if (sha === undefined) {
    return 1;
  }
  console.log(`sha=${sha}`);
  return 0;
}

// Real paths on both sides: Node resolves a symlinked entry point for
// import.meta.url, and an entry check that missed would print no SHA and exit 0.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    process.exitCode = await main(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
