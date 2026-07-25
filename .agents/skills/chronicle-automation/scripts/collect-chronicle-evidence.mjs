#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const SCRIPT_NAME = 'collect-chronicle-evidence';
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const SCHEDULE_SLACK_MINUTES = 90;
const CHARTERS_ROOT = '.night-shift/charters';
const WORKFLOWS_ROOT = '.github/workflows';

function fail(message) {
  process.stderr.write(`${SCRIPT_NAME}: ${message}\n`);
  process.exit(1);
}

function parseUtcIso(argument, value) {
  if (!/Z$/u.test(value)) {
    fail(`${argument} must be a UTC ISO timestamp ending in Z`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    fail(`${argument} is not a parseable UTC ISO timestamp: ${value}`);
  }
  return new Date(timestamp);
}

function parseArgs(argv) {
  const options = { pretty: false, revision: 'origin/main' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      process.stdout.write(
        'Usage: node collect-chronicle-evidence.mjs --repo <path> --window-start <UTC-ISO> --schedule-timezone <IANA-zone> [--window-end <UTC-ISO>] [--revision <revision>] [--pretty]\n'
      );
      process.exit(0);
    }
    if (argument === '--pretty') {
      options.pretty = true;
      continue;
    }
    if (
      !['--repo', '--revision', '--schedule-timezone', '--window-start', '--window-end'].includes(
        argument
      )
    ) {
      fail(`unsupported argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      fail(`${argument} requires a value`);
    }
    options[argument.slice(2)] = value;
    index += 1;
  }
  if (!options.repo) {
    fail('--repo is required');
  }
  if (!options['window-start']) {
    fail('--window-start is required');
  }
  // No default: an implicit UTC would silently reproduce the exact false
  // missed-wake anomalies this option exists to prevent. The caller reads the
  // declared value from charters/README.md "Timezones".
  if (!options['schedule-timezone']) {
    fail('--schedule-timezone is required (see .night-shift/charters/README.md "Timezones")');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: options['schedule-timezone'] });
  } catch {
    fail(`--schedule-timezone is not a recognized IANA zone: ${options['schedule-timezone']}`);
  }
  const windowStart = parseUtcIso('--window-start', options['window-start']);
  const windowEnd = options['window-end']
    ? parseUtcIso('--window-end', options['window-end'])
    : new Date();
  if (windowEnd.getTime() <= windowStart.getTime()) {
    fail('--window-end must be later than --window-start');
  }
  return { ...options, windowEnd, windowStart };
}

function execute(command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : '';
    const detail = stderr || (error instanceof Error ? error.message : String(error));
    fail(`${command} ${args.join(' ')} failed: ${detail}`);
  }
}

function validateRepo(repoArgument) {
  let repo;
  try {
    repo = realpathSync(resolve(repoArgument));
  } catch (error) {
    fail(
      `cannot resolve --repo ${repoArgument}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const topLevel = execute('git', ['-C', repo, 'rev-parse', '--show-toplevel'], repo).trim();
  let realTopLevel;
  try {
    realTopLevel = realpathSync(topLevel);
  } catch (error) {
    fail(
      `cannot resolve git work-tree root ${topLevel}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (realTopLevel !== repo) {
    fail(`--repo must name the git work-tree root: ${realTopLevel}`);
  }
  if (!existsSync(resolve(repo, '.night-shift/PROTOCOL.md'))) {
    fail(`${repo} does not contain .night-shift/PROTOCOL.md`);
  }
  return repo;
}

function git(repo, args) {
  return execute('git', ['-C', repo, ...args], repo);
}

function revisionPaths(repo, revision, root) {
  const output = git(repo, ['ls-tree', '-r', '--name-only', revision, '--', root]).trim();
  return output ? output.split(/\r?\n/u) : [];
}

function readRevisionFile(repo, revision, file) {
  try {
    return execFileSync('git', ['-C', repo, 'show', `${revision}:${file}`], {
      cwd: repo,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : '';
    const detail = stderr || (error instanceof Error ? error.message : String(error));
    fail(`cannot read ${file} at ${revision}: ${detail}`);
  }
}

function runJson(command, args, cwd) {
  const output = execute(command, args, cwd);
  try {
    return JSON.parse(output);
  } catch (error) {
    fail(
      `${command} ${args.join(' ')} returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function unquoteMetaValue(rawValue) {
  const value = rawValue.trim();
  if (value.startsWith('"')) {
    const closingQuote = value.indexOf('"', 1);
    if (closingQuote === -1) {
      fail(`unterminated quoted meta value: ${value}`);
    }
    return value.slice(1, closingQuote);
  }
  if (value.startsWith("'")) {
    const closingQuote = value.indexOf("'", 1);
    if (closingQuote === -1) {
      fail(`unterminated quoted meta value: ${value}`);
    }
    return value.slice(1, closingQuote);
  }
  return value.replace(/\s+#.*$/u, '').trim();
}

function parseCharterMeta(file, text) {
  const blocks = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/gu)];
  const meta = {};
  for (const block of blocks) {
    for (const line of block[1].split(/\r?\n/u)) {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line.trim());
      if (match) {
        meta[match[1]] = unquoteMetaValue(match[2]);
      }
    }
    if (meta.NAME) {
      break;
    }
  }
  if (!meta.NAME) {
    fail(`${file} charter meta block lacks NAME`);
  }
  if (!meta.SCHEDULE) {
    fail(`${file} charter meta block lacks SCHEDULE`);
  }
  return { name: meta.NAME, schedule: meta.SCHEDULE };
}

function parseCronField(field, minimum, maximum, label, allowSundaySeven = false) {
  if (field === '*') {
    return { matches: () => true, wildcard: true };
  }
  const stepMatch = /^\*\/(\d+)$/u.exec(field);
  if (stepMatch) {
    const step = Number.parseInt(stepMatch[1], 10);
    if (!Number.isSafeInteger(step) || step < 1 || step > maximum - minimum + 1) {
      fail(`unsupported cron ${label} field: ${field}`);
    }
    return {
      matches: (value) => (value - minimum) % step === 0,
      wildcard: false,
    };
  }
  // Comma list of parts, each a value or an a-b range with optional /step.
  if (!/^[\d,/-]+$/u.test(field)) {
    fail(`unsupported cron ${label} field: ${field}`);
  }
  const values = new Set();
  const normalize = (value) => (allowSundaySeven && value === 7 ? 0 : value);
  const validate = (value) => {
    const valid = (value >= minimum && value <= maximum) || (allowSundaySeven && value === 7);
    if (!valid) {
      fail(`cron ${label} value out of range: ${value}`);
    }
    return value;
  };
  for (const part of field.split(',')) {
    const rangeMatch = /^(\d+)-(\d+)(?:\/(\d+))?$/u.exec(part);
    if (rangeMatch) {
      const start = validate(Number.parseInt(rangeMatch[1], 10));
      const end = validate(Number.parseInt(rangeMatch[2], 10));
      const step = rangeMatch[3] ? Number.parseInt(rangeMatch[3], 10) : 1;
      if (start > end || !Number.isSafeInteger(step) || step < 1) {
        fail(`unsupported cron ${label} field: ${field}`);
      }
      for (let value = start; value <= end; value += step) {
        values.add(normalize(value));
      }
      continue;
    }
    if (!/^\d+$/u.test(part)) {
      fail(`unsupported cron ${label} field: ${field}`);
    }
    values.add(normalize(validate(Number.parseInt(part, 10))));
  }
  return { matches: (value) => values.has(value), wildcard: false };
}

function parseCron(cron) {
  const fields = cron.trim().split(/\s+/u);
  if (fields.length !== 5) {
    fail(`cron must contain exactly five fields: ${cron}`);
  }
  return {
    dayOfMonth: parseCronField(fields[2], 1, 31, 'day-of-month'),
    dayOfWeek: parseCronField(fields[4], 0, 6, 'day-of-week', true),
    hour: parseCronField(fields[1], 0, 23, 'hour'),
    minute: parseCronField(fields[0], 0, 59, 'minute'),
    month: parseCronField(fields[3], 1, 12, 'month'),
  };
}

const CRON_WEEKDAYS = { Fri: 5, Mon: 1, Sat: 6, Sun: 0, Thu: 4, Tue: 2, Wed: 3 };

// The scheduler evaluates cron fields on ITS OWN wall clock, not UTC
// (charters/README.md "Timezones"). Expected-wake arithmetic must therefore
// read each UTC instant's field values in the declared scheduler timezone —
// DST-aware via Intl, never a fixed offset.
function zonedCronFields(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    hour: 'numeric',
    hour12: false,
    minute: 'numeric',
    month: 'numeric',
    timeZone,
    weekday: 'short',
  }).formatToParts(instant);
  const byType = {};
  for (const part of parts) {
    byType[part.type] = part.value;
  }
  const dayOfWeek = CRON_WEEKDAYS[byType.weekday];
  if (dayOfWeek === undefined) {
    fail(`unrecognized weekday from timezone formatting: ${byType.weekday}`);
  }
  return {
    dayOfMonth: Number(byType.day),
    dayOfWeek,
    hour: Number(byType.hour) % 24,
    minute: Number(byType.minute),
    month: Number(byType.month),
  };
}

function countExpectedWakes(cronText, windowStart, windowEnd, timeZone) {
  const cron = parseCron(cronText);
  const cursor = new Date(windowStart);
  cursor.setUTCSeconds(0, 0);
  if (cursor.getTime() < windowStart.getTime()) {
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  let count = 0;
  while (cursor.getTime() < windowEnd.getTime()) {
    const fields = zonedCronFields(cursor, timeZone);
    const dayOfMonthMatches = cron.dayOfMonth.matches(fields.dayOfMonth);
    const dayOfWeekMatches = cron.dayOfWeek.matches(fields.dayOfWeek);
    const dayMatches =
      cron.dayOfMonth.wildcard && cron.dayOfWeek.wildcard
        ? true
        : cron.dayOfMonth.wildcard
          ? dayOfWeekMatches
          : cron.dayOfWeek.wildcard
            ? dayOfMonthMatches
            : dayOfMonthMatches || dayOfWeekMatches;
    if (
      cron.minute.matches(fields.minute) &&
      cron.hour.matches(fields.hour) &&
      cron.month.matches(fields.month) &&
      dayMatches
    ) {
      count += 1;
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return count;
}

function collectRoster(repo, revision, windowStart, windowEnd, scheduleTimezone) {
  const charterFiles = revisionPaths(repo, revision, CHARTERS_ROOT)
    .filter(
      (file) =>
        new RegExp(`^${CHARTERS_ROOT}/[^/]+\\.md$`, 'u').test(file) &&
        file !== `${CHARTERS_ROOT}/README.md`
    )
    .sort();
  if (charterFiles.length === 0) {
    fail(`no charter files found at ${revision}`);
  }
  // Wakes inside the trailing slack allowance are not late yet: count them
  // separately so a missed-wake verdict never fires on a legitimately
  // delayed loop that is still within scheduler slack.
  const slackMs = SCHEDULE_SLACK_MINUTES * 60 * 1000;
  const dueHorizon = new Date(Math.max(windowEnd.getTime() - slackMs, windowStart.getTime()));
  return charterFiles
    .map((file) => {
      const meta = parseCharterMeta(file, readRevisionFile(repo, revision, file));
      return {
        cron: meta.schedule,
        expectedWakes: countExpectedWakes(meta.schedule, windowStart, dueHorizon, scheduleTimezone),
        name: meta.name,
        pendingWakes: countExpectedWakes(meta.schedule, dueHorizon, windowEnd, scheduleTimezone),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function resolveRepository(repo) {
  const payload = runJson('gh', ['repo', 'view', '--json', 'nameWithOwner'], repo);
  if (
    !payload ||
    typeof payload.nameWithOwner !== 'string' ||
    !/^[^/\s]+\/[^/\s]+$/u.test(payload.nameWithOwner)
  ) {
    fail('gh repo view did not return a valid nameWithOwner');
  }
  const [owner, name] = payload.nameWithOwner.split('/');
  return { name, nameWithOwner: payload.nameWithOwner, owner };
}

function parseGitHubDate(value, label, nullable = false) {
  if (nullable && value === null) {
    return null;
  }
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    fail(`${label} is not a valid timestamp`);
  }
  return new Date(value);
}

function normalizePr(pr, index) {
  if (
    !pr ||
    typeof pr !== 'object' ||
    !Number.isSafeInteger(pr.number) ||
    typeof pr.title !== 'string' ||
    !['OPEN', 'MERGED', 'CLOSED'].includes(pr.state) ||
    typeof pr.isDraft !== 'boolean' ||
    typeof pr.headRefName !== 'string'
  ) {
    fail(`gh pr list returned malformed PR at index ${index}`);
  }
  const createdAt = parseGitHubDate(pr.createdAt, `PR #${pr.number} createdAt`);
  const mergedAt = parseGitHubDate(pr.mergedAt, `PR #${pr.number} mergedAt`, true);
  return {
    createdAt: createdAt.toISOString(),
    headRefName: pr.headRefName,
    isDraft: pr.isDraft,
    mergedAt: mergedAt?.toISOString() ?? null,
    number: pr.number,
    state: pr.state,
    title: pr.title,
  };
}

function collectReviewThreads(repo, repository, prNumber) {
  // commits(last: 1) is the head commit — exact for any commit count, unlike
  // `gh pr view --json commits`, which truncates to the oldest 100 and would
  // make lastCommitAt read stale on long-lived PRs (cli/cli#5415).
  const query = `
    query($owner:String!, $repo:String!, $number:Int!, $cursor:String) {
      repository(owner:$owner, name:$repo) {
        pullRequest(number:$number) {
          commits(last: 1) {
            nodes { commit { committedDate } }
          }
          reviewThreads(first:100, after:$cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { id isResolved }
          }
        }
      }
    }
  `;
  let cursor = null;
  let unresolvedThreads = 0;
  let lastCommitAt = null;
  const seenCursors = new Set();
  do {
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-F',
      `owner=${repository.owner}`,
      '-F',
      `repo=${repository.name}`,
      '-F',
      `number=${prNumber}`,
    ];
    if (cursor !== null) {
      args.push('-F', `cursor=${cursor}`);
    }
    const payload = runJson('gh', args, repo);
    const connection = payload?.data?.repository?.pullRequest?.reviewThreads;
    if (
      !(connection && Array.isArray(connection.nodes) && connection.pageInfo) ||
      typeof connection.pageInfo.hasNextPage !== 'boolean'
    ) {
      fail(`PR #${prNumber} returned an unexpected reviewThreads response`);
    }
    if (lastCommitAt === null) {
      const headCommit = payload?.data?.repository?.pullRequest?.commits?.nodes?.[0]?.commit;
      if (
        !headCommit ||
        typeof headCommit.committedDate !== 'string' ||
        !Number.isFinite(Date.parse(headCommit.committedDate))
      ) {
        fail(`PR #${prNumber} did not report a head commit with a committedDate`);
      }
      lastCommitAt = new Date(headCommit.committedDate).toISOString();
    }
    for (const thread of connection.nodes) {
      if (
        !thread ||
        typeof thread !== 'object' ||
        typeof thread.id !== 'string' ||
        typeof thread.isResolved !== 'boolean'
      ) {
        fail(`PR #${prNumber} returned a malformed review thread`);
      }
      if (!thread.isResolved) {
        unresolvedThreads += 1;
      }
    }
    if (connection.pageInfo.hasNextPage) {
      const nextCursor = connection.pageInfo.endCursor;
      if (typeof nextCursor !== 'string' || !nextCursor || seenCursors.has(nextCursor)) {
        fail(`PR #${prNumber} review-thread pagination omitted a unique next cursor`);
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } else {
      cursor = null;
    }
  } while (cursor !== null);
  return { lastCommitAt, unresolvedThreads };
}

function summarizeChecks(repo, prNumber) {
  const payload = runJson(
    'gh',
    ['pr', 'view', String(prNumber), '--json', 'statusCheckRollup'],
    repo
  );
  if (!(payload && Array.isArray(payload.statusCheckRollup))) {
    fail(`PR #${prNumber} did not report statusCheckRollup`);
  }
  let failing = 0;
  let pending = 0;
  for (const check of payload.statusCheckRollup) {
    if (!check || typeof check !== 'object') {
      fail(`PR #${prNumber} returned a malformed status check`);
    }
    if (typeof check.status === 'string' && check.status !== 'COMPLETED') {
      pending += 1;
      continue;
    }
    const state =
      typeof check.conclusion === 'string'
        ? check.conclusion
        : typeof check.state === 'string'
          ? check.state
          : null;
    if (!state) {
      fail(`PR #${prNumber} returned a status check without state`);
    }
    if (['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING'].includes(state)) {
      pending += 1;
    } else if (!['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(state)) {
      failing += 1;
    }
  }
  return { failing, pending };
}

function collectPullRequests(repo, repository, windowStart, windowEnd) {
  const payload = runJson(
    'gh',
    [
      'pr',
      'list',
      '--search',
      'head:night-shift/',
      '--state',
      'all',
      '--limit',
      '1000',
      '--json',
      'number,title,state,isDraft,headRefName,createdAt,mergedAt',
    ],
    repo
  );
  if (!Array.isArray(payload)) {
    fail('gh pr list did not return an array');
  }
  if (payload.length >= 1000) {
    fail('gh pr list reached its 1000-item limit; pagination completeness is unproven');
  }
  // Defense-in-depth: do not trust the search qualifier's matching semantics —
  // keep only branches that literally live under night-shift/.
  const prs = payload.map(normalizePr).filter((pr) => pr.headRefName.startsWith('night-shift/'));
  const inWindow = (iso) => {
    const timestamp = Date.parse(iso);
    return timestamp >= windowStart.getTime() && timestamp < windowEnd.getTime();
  };
  const byNumber = (left, right) => left.number - right.number;
  const merged = prs.filter((pr) => pr.mergedAt !== null && inWindow(pr.mergedAt)).sort(byNumber);
  const opened = prs.filter((pr) => inWindow(pr.createdAt)).sort(byNumber);
  const open = prs
    .filter((pr) => pr.state === 'OPEN')
    .sort(byNumber)
    .map((pr) => ({
      ...pr,
      checks: summarizeChecks(repo, pr.number),
      ...collectReviewThreads(repo, repository, pr.number),
    }));
  return { merged, open, opened };
}

function hasScheduledTrigger(text) {
  const lines = text.split(/\r?\n/u);
  let insideOn = false;
  for (const line of lines) {
    if (/^\s*#/u.test(line) || /^\s*$/u.test(line)) {
      continue;
    }
    if (/^on:\s*(?:#.*)?$/u.test(line)) {
      insideOn = true;
      continue;
    }
    if (insideOn && /^\S/u.test(line)) {
      insideOn = false;
    }
    if (insideOn && /^\s+schedule:\s*(?:#.*)?$/u.test(line)) {
      return true;
    }
  }
  return false;
}

function workflowName(file, text) {
  for (const line of text.split(/\r?\n/u)) {
    if (/^\s*#/u.test(line)) {
      continue;
    }
    const match = /^name:\s*(.+?)\s*$/u.exec(line);
    if (match) {
      const name = match[1].replace(/^(['"])(.*)\1$/u, '$2').trim();
      if (!name) {
        break;
      }
      return name;
    }
  }
  fail(`${file} has a schedule trigger but no top-level workflow name`);
}

function normalizeRun(run, file, index) {
  if (
    !run ||
    typeof run !== 'object' ||
    !Number.isSafeInteger(run.databaseId) ||
    typeof run.status !== 'string' ||
    typeof run.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(run.createdAt)) ||
    typeof run.headSha !== 'string'
  ) {
    fail(`${file} returned malformed workflow run at index ${index}`);
  }
  if (run.status === 'completed' || run.status === 'COMPLETED') {
    if (typeof run.conclusion !== 'string' || !run.conclusion) {
      fail(`${file} completed run ${run.databaseId} lacks a conclusion`);
    }
  } else if (run.conclusion !== null && typeof run.conclusion !== 'string') {
    fail(`${file} run ${run.databaseId} has a malformed conclusion`);
  }
  return {
    conclusion: run.conclusion,
    createdAt: new Date(run.createdAt).toISOString(),
    databaseId: run.databaseId,
    headSha: run.headSha,
    status: run.status,
  };
}

function listWorkflowRuns(repo, file, limit) {
  const payload = runJson(
    'gh',
    [
      'run',
      'list',
      '--workflow',
      file,
      // Scheduled streams only: a newer workflow_dispatch/debug run must not
      // stand in for (or mask) the nightly conclusion.
      '--event',
      'schedule',
      '--limit',
      String(limit),
      '--json',
      'databaseId,conclusion,status,createdAt,headSha',
    ],
    repo
  );
  if (!Array.isArray(payload)) {
    fail(`${file} gh run list did not return an array`);
  }
  if (payload.length > limit) {
    fail(`${file} gh run list returned more than its requested limit`);
  }
  return payload.map((run, index) => normalizeRun(run, file, index));
}

function collectScheduledWorkflows(repo, revision) {
  const workflowFiles = revisionPaths(repo, revision, WORKFLOWS_ROOT)
    .filter((file) => /^\.github\/workflows\/[^/]+\.yml$/u.test(file))
    .sort();
  const scheduled = [];
  for (const file of workflowFiles) {
    const text = readRevisionFile(repo, revision, file);
    if (!hasScheduledTrigger(text)) {
      continue;
    }
    const firstRuns = listWorkflowRuns(repo, file, 5);
    let inspectedRuns = firstRuns;
    let latestCompleted = firstRuns.find(
      (run) => run.status === 'completed' || run.status === 'COMPLETED'
    );
    if (!latestCompleted && firstRuns.length > 0) {
      inspectedRuns = listWorkflowRuns(repo, file, 100);
      latestCompleted = inspectedRuns.find(
        (run) => run.status === 'completed' || run.status === 'COMPLETED'
      );
    }
    scheduled.push({
      file,
      latestCompleted: latestCompleted ?? null,
      name: workflowName(file, text),
      pendingOnly: inspectedRuns.length > 0 && !latestCompleted,
    });
  }
  return scheduled;
}

function collect(options) {
  const repo = validateRepo(options.repo);
  const repository = resolveRepository(repo);
  return {
    generatedAt: new Date().toISOString(),
    prs: collectPullRequests(repo, repository, options.windowStart, options.windowEnd),
    roster: collectRoster(
      repo,
      options.revision,
      options.windowStart,
      options.windowEnd,
      options['schedule-timezone']
    ),
    scheduledWorkflows: collectScheduledWorkflows(repo, options.revision),
    schema: SCRIPT_NAME,
    window: {
      end: options.windowEnd.toISOString(),
      scheduleSlackMinutes: SCHEDULE_SLACK_MINUTES,
      scheduleTimezone: options['schedule-timezone'],
      start: options.windowStart.toISOString(),
    },
  };
}

const options = parseArgs(process.argv.slice(2));
const output = collect(options);
process.stdout.write(`${JSON.stringify(output, null, options.pretty ? 2 : 0)}\n`);
