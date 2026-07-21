#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BUFFER_BYTES = 128 * 1024 * 1024;
// biome-ignore lint/suspicious/noControlCharactersInRegex: GitHub logs contain ANSI escapes.
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const REQUIRED_FILES = ['AGENTS.md', '.night-shift/PROTOCOL.md', '.night-shift/charters/watch.md'];
const FAILURE_CONCLUSIONS = new Set([
  'action_required',
  'cancelled',
  'failure',
  'stale',
  'startup_failure',
  'timed_out',
]);

function usage() {
  return [
    'Usage: collect-watch-evidence.mjs --repo <path> [options]',
    '',
    'Options:',
    '  --watermark <key[,key...]>  Previously checkpointed completed-run keys, each <runId>@<attempt>;',
    '                             pass "none" (or an empty value) for an explicitly empty prior set',
    '  --preflight-port <port>    Check a local reproduction port (repeatable)',
    '  --pretty                   Pretty-print JSON',
    '  --help                     Show this help',
    '',
    'Read-only: derives Watch workflows, reconciles the external-state watermark,',
    'and collects bounded failure/retry evidence for newly observed runs.',
  ].join('\n');
}

export function parseArgs(argv) {
  let repo;
  let pretty = false;
  let watermarkSupplied = false;
  const watermark = [];
  const preflightPorts = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--repo') {
      repo = argv[index + 1];
      if (!repo) {
        throw new Error('--repo requires a path');
      }
      index += 1;
      continue;
    }
    if (argument === '--watermark') {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(
          '--watermark requires a value: <runId>@<attempt> keys, or "none" for an empty prior set'
        );
      }
      watermarkSupplied = true;
      if (!(value === '' || value === 'none')) {
        watermark.push(
          ...value
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)
        );
      }
      index += 1;
      continue;
    }
    if (argument === '--preflight-port') {
      const value = argv[index + 1];
      if (!/^\d+$/.test(value ?? '')) {
        throw new Error('--preflight-port requires an integer from 1 to 65535');
      }
      const port = Number.parseInt(value, 10);
      if (port < 1 || port > 65_535) {
        throw new Error('--preflight-port requires an integer from 1 to 65535');
      }
      preflightPorts.push(port);
      index += 1;
      continue;
    }
    if (argument === '--pretty') {
      pretty = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    throw new Error(`Unsupported argument: ${argument}`);
  }

  if (!repo) {
    throw new Error('--repo is required');
  }

  const invalidWatermark = watermark.find((value) => !/^\d+@\d+$/.test(value));
  if (invalidWatermark) {
    throw new Error(`Invalid watermark key (expected <runId>@<attempt>): ${invalidWatermark}`);
  }

  return {
    preflightPorts: uniqueSorted(preflightPorts),
    pretty,
    repo,
    watermark: uniqueSorted(watermark.map(String)),
    watermarkSupplied,
  };
}

function pinnedGitEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase().startsWith('GIT_')) {
      delete environment[key];
    }
  }
  environment.GIT_LITERAL_PATHSPECS = '1';
  environment.GIT_OPTIONAL_LOCKS = '0';
  environment.GIT_TERMINAL_PROMPT = '0';
  return environment;
}

function run(command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      env: pinnedGitEnvironment(),
      maxBuffer: MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = error?.stderr?.toString().trim();
    const detail = stderr ? `: ${stderr}` : '';
    throw new Error(`${command} ${args.join(' ')} failed${detail}`);
  }
}

function runJson(command, args, cwd) {
  const output = run(command, args, cwd).trim();
  if (!output) {
    throw new Error(`${command} ${args.join(' ')} returned no JSON`);
  }
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${command} ${args.join(' ')} returned malformed JSON`);
  }
}

function git(repo, args) {
  return run(
    'git',
    ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args],
    repo
  );
}

function assertRepository(repoInput) {
  const candidate = path.resolve(repoInput);
  if (!(existsSync(candidate) && statSync(candidate).isDirectory())) {
    throw new Error(`Repository does not exist: ${candidate}`);
  }
  const repo = realpathSync(candidate);
  const topLevel = realpathSync(git(repo, ['rev-parse', '--show-toplevel']).trim());
  if (topLevel !== repo) {
    throw new Error(`--repo must be the repository root; resolved ${topLevel}`);
  }
  for (const relativePath of REQUIRED_FILES) {
    const absolutePath = path.join(repo, relativePath);
    if (!(existsSync(absolutePath) && statSync(absolutePath).isFile())) {
      throw new Error(`Required file is missing: ${relativePath}`);
    }
  }
  return repo;
}

function assignment(charter, name) {
  const match = charter.match(new RegExp(`^${name}=(?:"([^"]+)"|([^#\\n]+))`, 'm'));
  if (!match) {
    throw new Error(`Watch charter is missing ${name}`);
  }
  return (match[1] ?? match[2]).trim();
}

export function deriveCharter(charter) {
  const lookbackMatch = charter.match(/last\s+(\d+)h\s+of runs/i);
  const fingerprintMatch = charter.match(
    /fingerprint\s*=\s*\n?\s*watch:<workflow>:<test-title-slug>:<error-class>/i
  );
  if (!lookbackMatch) {
    throw new Error('Could not derive the workflow lookback from Watch charter');
  }
  if (!fingerprintMatch) {
    throw new Error('Could not derive the fingerprint shape from Watch charter');
  }
  if (!/derive the list from \.github\/workflows\//i.test(charter)) {
    throw new Error('Watch charter no longer requires workflow derivation');
  }
  if (!/NEVER fix, skip, quarantine, retry-mask, or edit tests/i.test(charter)) {
    throw new Error('Watch diagnose-only safety boundary is missing');
  }

  return {
    autonomy: assignment(charter, 'AUTONOMY'),
    fingerprintShape: 'watch:<workflow>:<test-title-slug>:<error-class>',
    lookbackHours: Number.parseInt(lookbackMatch[1], 10),
    name: assignment(charter, 'NAME'),
    role: assignment(charter, 'ROLE'),
    stateIssue: assignment(charter, 'STATE_ISSUE'),
    version: assignment(charter, 'CHARTER_VERSION'),
    wallClockBudget: assignment(charter, 'WALL_CLOCK_BUDGET'),
  };
}

function yamlScalar(line) {
  const value = line.replace(/^[^:]+:\s*/, '').trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function deriveWatchedWorkflows(repo) {
  const workflowRoot = path.join(repo, '.github', 'workflows');
  if (!(existsSync(workflowRoot) && statSync(workflowRoot).isDirectory())) {
    throw new Error('Required workflow directory is missing: .github/workflows');
  }

  const scheduled = [];
  for (const entry of readdirSync(workflowRoot, { withFileTypes: true })) {
    if (!(entry.isFile() && /\.ya?ml$/i.test(entry.name))) {
      continue;
    }
    const relativePath = path.posix.join('.github', 'workflows', entry.name);
    const text = readFileSync(path.join(workflowRoot, entry.name), 'utf8');
    const lines = text.split(/\r?\n/);
    const nameLine = lines.find((line) => /^name:\s*\S/.test(line));
    if (!nameLine) {
      throw new Error(`Workflow is missing a top-level name: ${relativePath}`);
    }
    const name = yamlScalar(nameLine);
    const onIndex = lines.findIndex((line) => /^on:\s*$/.test(line));
    if (onIndex < 0) {
      continue;
    }
    let hasSchedule = false;
    for (let index = onIndex + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^\S/.test(line) && line.trim()) {
        break;
      }
      if (/^\s{2}schedule:\s*$/.test(line)) {
        hasSchedule = true;
      }
    }
    if (!hasSchedule) {
      continue;
    }
    const included = /(?:\be2e\b|\bnightly\b)/i.test(name);
    scheduled.push({
      exclusionReason: included ? null : 'name lacks an E2E or nightly token',
      included,
      name,
      path: relativePath,
    });
  }

  scheduled.sort((left, right) => left.path.localeCompare(right.path));
  const watched = scheduled
    .filter((workflow) => workflow.included)
    .map((workflow) => ({ name: workflow.name, path: workflow.path }));
  if (watched.length === 0) {
    throw new Error('Derived no scheduled E2E or nightly workflows');
  }
  return { scheduled, watched };
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) =>
    String(left).localeCompare(String(right), undefined, { numeric: true })
  );
}

function runKey(runItem) {
  return `${runItem.id}@${runItem.attempt}`;
}

export function compareWatermark({ previousKeys, runs, supplied }) {
  const previous = uniqueSorted(previousKeys.map(String));
  const currentRunKeys = uniqueSorted(runs.map(runKey));
  const checkpointWatermark = uniqueSorted(
    runs.filter((runItem) => runItem.status === 'completed').map(runKey)
  );
  const pendingRuns = runs
    .filter((runItem) => runItem.status !== 'completed')
    .map((runItem) => ({ attempt: runItem.attempt, id: runItem.id, status: runItem.status }))
    .sort((left, right) => runKey(left).localeCompare(runKey(right), undefined, { numeric: true }));
  const previousSet = new Set(previous);
  const currentSet = new Set(currentRunKeys);
  const completedSet = new Set(checkpointWatermark);
  const newRunKeys = currentRunKeys.filter((key) => !previousSet.has(key));
  const expiredRunKeys = previous.filter((key) => !currentSet.has(key));
  const unchanged = supplied && newRunKeys.length === 0 && expiredRunKeys.length === 0;
  const noopEligible =
    supplied &&
    pendingRuns.length === 0 &&
    checkpointWatermark.every((key) => previousSet.has(key)) &&
    previous.every((key) => completedSet.has(key));
  return {
    checkpointWatermark,
    currentRunKeys,
    expiredRunKeys,
    newRunKeys,
    noopEligible,
    pendingRuns,
    previousRunKeys: previous,
    supplied,
    unchanged,
  };
}

function apiPages(repo, endpoint) {
  const pages = runJson(
    'gh',
    ['api', '--paginate', '--slurp', '-H', 'Accept: application/vnd.github+json', endpoint],
    repo
  );
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error(`GitHub pagination returned an unexpected shape for ${endpoint}`);
  }
  return pages;
}

function flattenObjectPages(pages, key, endpoint) {
  if (pages.some((page) => !(page && Array.isArray(page[key])))) {
    throw new Error(`GitHub pagination omitted ${key} for ${endpoint}`);
  }
  const values = pages.flatMap((page) => page[key]);
  const totals = uniqueSorted(
    pages.map((page) => page.total_count).filter((value) => Number.isInteger(value))
  );
  if (totals.length > 1) {
    throw new Error(`GitHub pagination changed total_count for ${endpoint}`);
  }
  if (totals.length === 1 && Number(totals[0]) !== values.length) {
    throw new Error(
      `GitHub pagination was incomplete for ${endpoint}: expected ${totals[0]}, received ${values.length}`
    );
  }
  return values;
}

function repositoryIdentity(repo) {
  const value = runJson('gh', ['repo', 'view', '--json', 'nameWithOwner,url'], repo);
  if (typeof value?.nameWithOwner !== 'string' || typeof value?.url !== 'string') {
    throw new Error('Could not prove GitHub repository identity');
  }
  return { nameWithOwner: value.nameWithOwner, url: value.url };
}

function resolveWorkflowMetadata(repo, repository, derivedWorkflows) {
  const endpoint = `/repos/${repository}/actions/workflows?per_page=100`;
  const remoteWorkflows = flattenObjectPages(apiPages(repo, endpoint), 'workflows', endpoint);
  return derivedWorkflows.map((derived) => {
    const matches = remoteWorkflows.filter((workflow) => workflow.path === derived.path);
    if (matches.length !== 1) {
      throw new Error(
        `Expected exactly one GitHub workflow for ${derived.path}; found ${matches.length}`
      );
    }
    const workflow = matches[0];
    if (
      !Number.isInteger(workflow.id) ||
      typeof workflow.name !== 'string' ||
      typeof workflow.state !== 'string' ||
      typeof workflow.html_url !== 'string'
    ) {
      throw new Error(`GitHub returned incomplete workflow metadata for ${derived.path}`);
    }
    if (workflow.name !== derived.name) {
      throw new Error(
        `Workflow name drift for ${derived.path}: local=${derived.name}, GitHub=${workflow.name}`
      );
    }
    return {
      id: workflow.id,
      name: workflow.name,
      path: workflow.path,
      state: workflow.state,
      url: workflow.html_url,
    };
  });
}

function normalizeRun(run, workflow) {
  if (
    !(Number.isInteger(run?.id) && Number.isInteger(run?.run_attempt)) ||
    typeof run?.html_url !== 'string' ||
    typeof run?.head_sha !== 'string' ||
    typeof run?.status !== 'string' ||
    typeof run?.created_at !== 'string' ||
    typeof run?.updated_at !== 'string' ||
    typeof run?.event !== 'string'
  ) {
    throw new Error(`GitHub returned incomplete run metadata for ${workflow.name}`);
  }
  return {
    attempt: run.run_attempt,
    conclusion: run.conclusion ?? null,
    createdAt: run.created_at,
    event: run.event,
    headBranch: run.head_branch ?? null,
    headSha: run.head_sha,
    id: String(run.id),
    status: run.status,
    title: run.display_title ?? null,
    updatedAt: run.updated_at,
    url: run.html_url,
    workflow,
  };
}

function collectRunSnapshot(repo, repository, workflows, since) {
  const created = encodeURIComponent(`>=${since}`);
  const endpoint = `/repos/${repository}/actions/runs?per_page=100&created=${created}`;
  const workflowById = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  const runs = flattenObjectPages(apiPages(repo, endpoint), 'workflow_runs', endpoint)
    .filter((runItem) => workflowById.has(runItem.workflow_id))
    .map((runItem) => normalizeRun(runItem, workflowById.get(runItem.workflow_id)))
    .filter((runItem) => Date.parse(runItem.createdAt) >= Date.parse(since));
  return runs.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

export function assertStableRunSnapshots(first, second) {
  const signature = (runs) =>
    runs
      .map((runItem) => ({
        attempt: runItem.attempt,
        conclusion: runItem.conclusion,
        id: runItem.id,
        status: runItem.status,
        updatedAt: runItem.updatedAt,
        workflowId: runItem.workflow.id,
      }))
      .sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));
  const firstSignature = signature(first);
  const secondSignature = signature(second);
  if (JSON.stringify(firstSignature) !== JSON.stringify(secondSignature)) {
    throw new Error(
      'GitHub workflow-run snapshot changed during collection; rerun after external state settles'
    );
  }
}

function normalizeJob(job, runId, attempt) {
  if (
    !Number.isInteger(job?.id) ||
    typeof job?.name !== 'string' ||
    typeof job?.status !== 'string' ||
    !Array.isArray(job?.steps)
  ) {
    throw new Error(`GitHub returned incomplete job metadata for run ${runId} attempt ${attempt}`);
  }
  return {
    attempt,
    conclusion: job.conclusion ?? null,
    id: String(job.id),
    labels: Array.isArray(job.labels) ? job.labels.map(String) : [],
    name: job.name,
    runnerGroupName: job.runner_group_name ?? null,
    runnerName: job.runner_name ?? null,
    startedAt: job.started_at ?? null,
    status: job.status,
    steps: job.steps.map((step) => ({
      conclusion: step.conclusion ?? null,
      name: String(step.name ?? ''),
      number: step.number ?? null,
      status: step.status ?? null,
    })),
    url: job.html_url ?? null,
  };
}

function listJobs(repo, repository, runId, attempt) {
  const endpoint = `/repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`;
  return flattenObjectPages(apiPages(repo, endpoint), 'jobs', endpoint).map((job) =>
    normalizeJob(job, runId, attempt)
  );
}

function cleanLogLine(value) {
  return value.replace(ANSI_ESCAPE_PATTERN, '').replace(/\r/g, '').trimEnd();
}

function logRecords(logText) {
  return cleanLogLine(logText)
    .split('\n')
    .filter(Boolean)
    .map((raw, index) => {
      const match = raw.match(/^([^\t]+)\t([^\t]+)\t\uFEFF?(\S+)\s+(.*)$/);
      if (match) {
        return {
          index,
          job: match[1],
          message: match[4].trim(),
          raw,
          step: match[2],
          timestamp: match[3],
        };
      }
      return {
        index,
        job: null,
        message: raw.trim(),
        raw,
        step: null,
        timestamp: null,
      };
    });
}

function normalizeTitle(value) {
  return value
    .replace(/^\s*\d+\)\s*/, '')
    .replace(/^\[[^\]]+\]\s*›\s*/, '')
    .replace(/\s*─+\s*$/, '')
    .replace(/\s*\(retry #\d+\)\s*$/i, '')
    .replace(/([/\\][^\s›]+):\d+:\d+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function testTitleFromMessage(message) {
  const playwright = message.match(/^\s*\d+\)\s+(.+?)(?:\s+\(retry #\d+\))?\s*$/i);
  if (playwright?.[1]?.includes('›')) {
    return normalizeTitle(playwright[0]);
  }
  const vitest = message.match(/^\s*FAIL\s+(.+?)\s+>\s+(.+)$/);
  if (vitest) {
    return normalizeTitle(`${vitest[1]} › ${vitest[2].replace(/\s+>\s+/g, ' › ')}`);
  }
  return null;
}

function retrySignalFromMessage(message) {
  const progress = message.match(
    /^([✓✘×])\s+\d+\s+\[([^\]]+)\]\s*›\s*(.+?)\s+\(retry #(\d+)\)(?:\s+\([^)]+\))?\s*$/i
  );
  if (progress) {
    return {
      outcome: progress[1] === '✓' ? 'passed' : 'failed',
      retry: Number.parseInt(progress[4], 10),
      testTitle: normalizeTitle(`[${progress[2]}] › ${progress[3]}`),
    };
  }
  const failureSummary = message.match(/^\s*\d+\)\s+(.+?)\s+\(retry #(\d+)\)\s*─*\s*$/i);
  if (failureSummary) {
    return {
      outcome: 'failed',
      retry: Number.parseInt(failureSummary[2], 10),
      testTitle: normalizeTitle(failureSummary[1]),
    };
  }
  return null;
}

export function errorClassFromMessage(message) {
  if (/test timeout of \d+ms exceeded/i.test(message)) {
    return 'test-timeout';
  }
  if (
    /locator\.[a-z]+:.*(?:timeout|timed out)|waiting for (?:getby|locator|selector)/i.test(message)
  ) {
    return 'locator-timeout';
  }
  if (/expect(?:\.|\().*(?:to|received)|assertionerror/i.test(message)) {
    return 'assertion';
  }
  if (/\btypeerror:/i.test(message)) {
    return 'type-error';
  }
  if (/\breferenceerror:/i.test(message)) {
    return 'reference-error';
  }
  if (/\btargetclosederror:/i.test(message)) {
    return 'target-closed';
  }
  if (/\b(?:step|action)\b.*has timed out after/i.test(message)) {
    return 'step-timeout';
  }
  if (
    /job (?:was )?cancelled because it exceeded|job timed out|exceeded the maximum execution time/i.test(
      message
    )
  ) {
    return 'job-timeout';
  }
  if (/the operation was canceled|the operation was cancelled/i.test(message)) {
    return 'operation-cancelled';
  }
  const exitMatch = message.match(/process completed with exit code (\d+)/i);
  if (exitMatch) {
    return `process-exit-${exitMatch[1]}`;
  }
  if (/\berror:\s+.+/i.test(message)) {
    return 'error';
  }
  return null;
}

function slug(value) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unnamed'
  );
}

function excerpt(records, centerIndex, radius = 2) {
  const start = Math.max(0, centerIndex - radius);
  const end = Math.min(records.length, centerIndex + radius + 1);
  return records.slice(start, end).map((record) => record.message.slice(0, 500));
}

export function fingerprint(workflowName, title, errorClass) {
  const fullPath = title
    .split('›')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join(' ');
  const titleSlug = slug(fullPath);
  const boundedSlug = titleSlug.length > 80 ? titleSlug.slice(0, 80).replace(/-+$/, '') : titleSlug;
  return `watch:${slug(workflowName)}:${boundedSlug || 'unnamed'}:${errorClass}`;
}

function refineErrorEvidence(records, error) {
  const pointerInterception = records.find((record) =>
    /intercepts pointer events/i.test(record.message)
  );
  const locatorAction = records
    .map((record) => record.message.match(/Error:\s*locator\.([a-z]+):.*(?:timeout|timed out)/i))
    .find(Boolean)?.[1];
  if (pointerInterception && locatorAction) {
    return {
      errorClass: `locator-${locatorAction.toLowerCase()}-timeout-pointer-interception`,
      mechanismSignals: [pointerInterception.message.slice(0, 500)],
    };
  }
  const durationThreshold = records.find((record) =>
    /(?:duration|performance).*(?:threshold|budget|exceed)|(?:took|received).*(?:ms|milliseconds).*(?:expected|limit|budget)/i.test(
      record.message
    )
  );
  if (durationThreshold) {
    return {
      errorClass: 'duration-threshold-exceeded',
      mechanismSignals: [durationThreshold.message.slice(0, 500)],
    };
  }
  return { errorClass: error.errorClass, mechanismSignals: [] };
}

function fingerprintReady(errorClass) {
  return (
    errorClass === 'step-timeout' ||
    errorClass === 'job-timeout' ||
    errorClass === 'duration-threshold-exceeded' ||
    /^locator-[a-z]+-timeout-pointer-interception$/.test(errorClass)
  );
}

function runnerImage(records) {
  const image = records
    .map((record) => record.message.match(/^Image:\s*(.+)$/i)?.[1]?.trim())
    .find(Boolean);
  const version = records
    .map((record) => record.message.match(/^Version:\s*(.+)$/i)?.[1]?.trim())
    .find(Boolean);
  const osHeaderIndex = records.findIndex((record) =>
    /^Operating System$/i.test(record.message.trim())
  );
  const operatingSystem =
    osHeaderIndex >= 0 ? records[osHeaderIndex + 1]?.message.trim() || null : null;
  if (!(image || version || operatingSystem)) {
    return null;
  }
  return {
    image: image ?? null,
    operatingSystem: operatingSystem ?? null,
    version: version ?? null,
  };
}

function strongestError(records) {
  const ranked = records
    .map((record) => ({ errorClass: errorClassFromMessage(record.message), record }))
    .filter((value) => value.errorClass)
    .map((value) => ({
      ...value,
      rank:
        value.errorClass === 'step-timeout' || value.errorClass === 'job-timeout'
          ? 6
          : value.errorClass === 'operation-cancelled'
            ? 5
            : value.errorClass === 'test-timeout' || value.errorClass === 'locator-timeout'
              ? 4
              : value.errorClass === 'error'
                ? 1
                : value.errorClass.startsWith('process-exit-')
                  ? 2
                  : 3,
    }))
    .sort((left, right) => right.rank - left.rank || left.record.index - right.record.index);
  return ranked[0] ?? null;
}

export function extractLogEvidence({ attempt, jobs, logText, workflowName }) {
  const records = logRecords(logText);
  const failureCandidates = [];
  const retrySignals = [];
  const unattributedCandidates = [];
  const unparsedFailures = [];
  const imagesByJob = {};

  const unattributedRecords = records.filter((record) => record.job === null);
  for (let index = 0; index < unattributedRecords.length; index += 1) {
    const record = unattributedRecords[index];
    const retrySignal = retrySignalFromMessage(record.message);
    if (retrySignal) {
      retrySignals.push({
        attempt,
        excerpt: excerpt(unattributedRecords, index),
        job: null,
        ...retrySignal,
      });
    }

    const title = testTitleFromMessage(record.message);
    if (!title) {
      continue;
    }
    const window = unattributedRecords.slice(index + 1, index + 31);
    const error = strongestError(window);
    if (!error) {
      continue;
    }
    const refined = refineErrorEvidence(window, error);
    unattributedCandidates.push({
      attempt,
      errorClass: refined.errorClass,
      errorLine: error.record.message.slice(0, 500),
      excerpt: excerpt(unattributedRecords, unattributedRecords.indexOf(error.record)),
      fingerprintCandidate: fingerprint(workflowName, title, refined.errorClass),
      fingerprintReady: fingerprintReady(refined.errorClass),
      job: null,
      mechanismSignals: refined.mechanismSignals,
      phase: error.record.step,
      syntheticPhaseTitle: false,
      testTitle: title,
    });
  }

  for (const job of jobs) {
    const jobRecords = records.filter((record) => record.job === job.name);
    imagesByJob[job.name] = runnerImage(jobRecords);

    for (let index = 0; index < jobRecords.length; index += 1) {
      const record = jobRecords[index];
      const retrySignal = retrySignalFromMessage(record.message);
      if (retrySignal) {
        retrySignals.push({
          attempt,
          excerpt: excerpt(jobRecords, index),
          job: job.name,
          ...retrySignal,
        });
      }

      const title = testTitleFromMessage(record.message);
      if (!title) {
        continue;
      }
      const window = jobRecords.slice(index + 1, index + 31);
      const error = strongestError(window);
      if (!error) {
        continue;
      }
      const refined = refineErrorEvidence(window, error);
      failureCandidates.push({
        attempt,
        errorClass: refined.errorClass,
        errorLine: error.record.message.slice(0, 500),
        excerpt: excerpt(jobRecords, jobRecords.indexOf(error.record)),
        fingerprintCandidate: fingerprint(workflowName, title, refined.errorClass),
        fingerprintReady: fingerprintReady(refined.errorClass),
        job: job.name,
        mechanismSignals: refined.mechanismSignals,
        phase: error.record.step,
        syntheticPhaseTitle: false,
        testTitle: title,
      });
    }

    if (!FAILURE_CONCLUSIONS.has(job.conclusion)) {
      continue;
    }
    const jobCandidates = failureCandidates.filter((candidate) => candidate.job === job.name);
    if (jobCandidates.length > 0) {
      continue;
    }
    const failedSteps = job.steps.filter((step) => FAILURE_CONCLUSIONS.has(step.conclusion));
    const phase = failedSteps.at(-1)?.name ?? null;
    const phaseRecords = phase ? jobRecords.filter((record) => record.step === phase) : [];
    const error = strongestError(phaseRecords.length > 0 ? phaseRecords : jobRecords);
    if (error && phase) {
      const title = `${job.name} › ${phase}`;
      const refined = refineErrorEvidence(
        phaseRecords.length > 0 ? phaseRecords : jobRecords,
        error
      );
      failureCandidates.push({
        attempt,
        errorClass: refined.errorClass,
        errorLine: error.record.message.slice(0, 500),
        excerpt: excerpt(jobRecords, jobRecords.indexOf(error.record)),
        fingerprintCandidate: fingerprint(workflowName, title, refined.errorClass),
        fingerprintReady: fingerprintReady(refined.errorClass),
        job: job.name,
        mechanismSignals: refined.mechanismSignals,
        phase,
        syntheticPhaseTitle: true,
        testTitle: title,
      });
      continue;
    }
    unparsedFailures.push({
      attempt,
      conclusion: job.conclusion,
      failedSteps: failedSteps.map((step) => step.name),
      job: job.name,
      reason: error ? 'failed-step-missing' : 'error-signature-missing',
      tail: jobRecords.slice(-8).map((record) => record.message.slice(0, 500)),
    });
  }

  const dedupe = (values, key) => [...new Map(values.map((value) => [key(value), value])).values()];
  return {
    failureCandidates: dedupe(
      failureCandidates,
      (value) => `${value.attempt}:${value.job}:${value.fingerprintCandidate}:${value.errorLine}`
    ),
    imagesByJob,
    retrySignals: dedupe(
      retrySignals,
      (value) => `${value.attempt}:${value.job}:${value.retry}:${value.outcome}:${value.testTitle}`
    ),
    unattributedCandidates: dedupe(
      unattributedCandidates,
      (value) => `${value.attempt}:${value.job}:${value.fingerprintCandidate}:${value.errorLine}`
    ),
    unparsedFailures,
  };
}

function workflowRetryRecoveries(attempts) {
  const recoveries = [];
  for (let index = 1; index < attempts.length; index += 1) {
    const previous = attempts[index - 1];
    const current = attempts[index];
    for (const currentJob of current.jobs) {
      const previousJob = previous.jobs.find((job) => job.name === currentJob.name);
      if (
        previousJob &&
        FAILURE_CONCLUSIONS.has(previousJob.conclusion) &&
        currentJob.conclusion === 'success'
      ) {
        recoveries.push({
          failedAttempt: previous.attempt,
          job: currentJob.name,
          passedAttempt: current.attempt,
        });
      }
    }
  }
  return recoveries;
}

function collectRunEvidence(repo, repository, runItem) {
  const attempts = [];
  for (let attempt = 1; attempt <= runItem.attempt; attempt += 1) {
    const jobs = listJobs(repo, repository, runItem.id, attempt);
    if (runItem.status !== 'completed') {
      attempts.push({ attempt, jobs, logStatus: 'run-not-completed' });
      continue;
    }
    const logText = run(
      'gh',
      ['run', 'view', runItem.id, '--repo', repository, '--attempt', String(attempt), '--log'],
      repo
    );
    const hasInspectableJob = jobs.some(
      (job) => job.conclusion && job.conclusion !== 'skipped' && job.status === 'completed'
    );
    if (!logText.trim() && hasInspectableJob) {
      throw new Error(`GitHub returned empty logs for run ${runItem.id} attempt ${attempt}`);
    }
    const evidence = extractLogEvidence({
      attempt,
      jobs,
      logText,
      workflowName: runItem.workflow.name,
    });
    attempts.push({
      attempt,
      jobs,
      logStatus: 'collected',
      ...evidence,
    });
  }

  const failureCandidates = attempts.flatMap((attempt) => attempt.failureCandidates ?? []);
  const retrySignals = attempts.flatMap((attempt) => attempt.retrySignals ?? []);
  const unattributedCandidates = attempts.flatMap(
    (attempt) => attempt.unattributedCandidates ?? []
  );
  const unparsedFailures = attempts.flatMap((attempt) => attempt.unparsedFailures ?? []);
  const recoveries = workflowRetryRecoveries(attempts);
  const passOnRetryCandidates = [
    ...recoveries.map((recovery) => ({ kind: 'workflow-rerun', ...recovery })),
    ...retrySignals
      .filter((signal) => signal.outcome === 'passed')
      .map((signal) => ({
        kind: 'test-pass-on-retry',
        ...signal,
        finalRunConclusion: runItem.conclusion,
      })),
  ];
  return {
    ...runItem,
    analysisComplete: runItem.status === 'completed' && unparsedFailures.length === 0,
    attempts,
    failureCandidates,
    passOnRetryCandidates,
    unattributedCandidates,
    unparsedFailures,
  };
}

export function parseLsofOutput(output, port) {
  const listeners = [];
  let current = {};
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const type = line[0];
    const value = line.slice(1);
    if (type === 'p') {
      if (current.pid) {
        listeners.push(current);
      }
      current = { pid: value, port };
      continue;
    }
    if (type === 'c') {
      current.command = value;
      continue;
    }
    if (type === 'n') {
      current.name = value;
    }
  }
  if (current.pid) {
    listeners.push(current);
  }
  return listeners;
}

function preflightPort(port) {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpcn'], {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw new Error(`lsof failed for port ${port}: ${result.error.message}`);
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`lsof failed for port ${port}: ${(result.stderr ?? '').trim()}`);
  }
  const listeners = parseLsofOutput(result.stdout ?? '', port);
  return { available: listeners.length === 0, listeners, port };
}

function workingTree(repo) {
  return {
    branch: git(repo, ['branch', '--show-current']).trim() || null,
    head: git(repo, ['rev-parse', 'HEAD']).trim(),
    status: git(repo, ['status', '--short', '--untracked-files=all'])
      .trim()
      .split('\n')
      .filter(Boolean),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = assertRepository(args.repo);
  const charter = deriveCharter(
    readFileSync(path.join(repo, '.night-shift', 'charters', 'watch.md'), 'utf8')
  );
  const identity = repositoryIdentity(repo);
  const derived = deriveWatchedWorkflows(repo);
  const workflows = resolveWorkflowMetadata(repo, identity.nameWithOwner, derived.watched);
  const until = new Date();
  const since = new Date(until.getTime() - charter.lookbackHours * 60 * 60 * 1000);
  const firstRunSnapshot = collectRunSnapshot(
    repo,
    identity.nameWithOwner,
    workflows,
    since.toISOString()
  );
  const runs = collectRunSnapshot(repo, identity.nameWithOwner, workflows, since.toISOString());
  assertStableRunSnapshots(firstRunSnapshot, runs);
  const watermark = compareWatermark({
    previousKeys: args.watermark,
    runs,
    supplied: args.watermarkSupplied,
  });
  const keysToAnalyze = new Set(
    watermark.supplied ? watermark.newRunKeys : watermark.currentRunKeys
  );
  const selectedRuns = watermark.noopEligible
    ? []
    : runs.filter((runItem) => keysToAnalyze.has(`${runItem.id}@${runItem.attempt}`));
  const analyzedRuns = selectedRuns.map((runItem) =>
    collectRunEvidence(repo, identity.nameWithOwner, runItem)
  );
  const blockingReasons = analyzedRuns.flatMap((runItem) => {
    const reasons = [];
    if (runItem.status !== 'completed') {
      reasons.push(`run-not-completed:${runItem.id}`);
    }
    if (runItem.unparsedFailures.length > 0) {
      reasons.push(`unparsed-failures:${runItem.id}:${runItem.unparsedFailures.length}`);
    }
    return reasons;
  });
  const reproductionPreflight = args.preflightPorts.map(preflightPort);

  const output = {
    charter,
    collection: {
      analysisComplete: blockingReasons.length === 0,
      analyzedRunKeys: analyzedRuns.map((runItem) => `${runItem.id}@${runItem.attempt}`),
      blockingReasons,
      skippedBecauseWatermarkUnchanged: watermark.noopEligible,
    },
    generatedAt: until.toISOString(),
    repository: identity,
    reproductionPreflight,
    runs: analyzedRuns,
    scheduledWorkflows: derived.scheduled,
    schemaVersion: 2,
    watermark,
    window: { since: since.toISOString(), until: until.toISOString() },
    workflows,
    workingTree: workingTree(repo),
  };
  process.stdout.write(`${JSON.stringify(output, null, args.pretty ? 2 : 0)}\n`);
}

const isMain = process.argv[1]
  ? pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url
  : false;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`collect-watch-evidence: ${error.message}\n`);
    process.exitCode = 1;
  });
}
