#!/usr/bin/env node
// Counts the recent fix, test and revert commits that touch each path, so an
// area that keeps failing shows up before another patch lands there (AGENTS.md,
// "Repeated failures mean the design is wrong"). Exit 0: nothing hot; 2: a path
// is hot; 1: the count could not be made.
//
//   pnpm defect-density -- <path>... [--days 14] [--threshold 3] [--json]
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const DAY_MS = 86_400_000;
const HOT_EXIT = 2;
const FIX_SUBJECT = /^(?:fix|test|revert)(?:\([^)]*\))?!?:/u;
const NIGHTLY_NOTE =
  "Nightly-alert issues are not counted: this script reads git only. Check Linear's nightly-alert issues for these paths.";

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`--${name} must be a positive integer, not "${value}".`);
  }
  return number;
}

function parseCli(argv) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    // pnpm forwards the `--` in `pnpm defect-density -- <paths>`.
    args: argv[0] === '--' ? argv.slice(1) : argv,
    options: {
      days: { default: '14', type: 'string' },
      json: { default: false, type: 'boolean' },
      threshold: { default: '3', type: 'string' },
    },
    strict: true,
  });
  if (positionals.length === 0) {
    throw new Error('Name at least one path: pnpm defect-density -- <path>...');
  }
  return {
    days: positiveInteger(values.days, 'days'),
    json: values.json,
    paths: positionals,
    threshold: positiveInteger(values.threshold, 'threshold'),
  };
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function measure({ days, paths, threshold }) {
  if (git(['rev-parse', '--is-shallow-repository']).trim() === 'true') {
    throw new Error(
      'This clone has shallow history, so recent fixes would be undercounted. Fetch the full history first: git fetch --unshallow'
    );
  }
  const since = new Date(Date.now() - days * DAY_MS).toISOString();
  const results = paths.map((target) => {
    if (git(['rev-list', '-1', 'HEAD', '--', target]).trim() === '') {
      throw new Error(`No commit on this branch touches ${target}; check the path.`);
    }
    const commits = git([
      'log',
      `--since=${since}`,
      '--format=%h%x09%cs%x09%s',
      'HEAD',
      '--',
      target,
    ])
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, date, ...subject] = line.split('\t');
        return { date, sha, subject: subject.join('\t') };
      })
      .filter(({ subject }) => FIX_SUBJECT.test(subject));
    return { commits, count: commits.length, hot: commits.length >= threshold, path: target };
  });
  return {
    days,
    hot: results.some(({ hot }) => hot),
    nightlyIssues: { counted: false, note: NIGHTLY_NOTE },
    paths: results,
    since: since.slice(0, 10),
    threshold,
  };
}

function format(report) {
  const lines = [
    `Fix, test and revert commits on HEAD since ${report.since} (${report.days} days); ${report.threshold} or more is HOT.`,
  ];
  for (const { commits, count, hot, path } of report.paths) {
    lines.push('', `${path}: ${count}${hot ? ' HOT' : ''}`);
    for (const { date, sha, subject } of commits) {
      lines.push(`  ${sha} ${date} ${subject}`);
    }
  }
  lines.push('', report.nightlyIssues.note);
  return `${lines.join('\n')}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const options = parseCli(process.argv.slice(2));
    const report = measure(options);
    process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : format(report));
    process.exitCode = report.hot ? HOT_EXIT : 0;
  } catch (error) {
    process.stderr.write(`defect-density: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
