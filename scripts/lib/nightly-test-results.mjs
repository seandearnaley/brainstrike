// Reads the Playwright JSON reports a nightly workflow uploaded into per-test
// outcomes for scripts/notify-linear-nightly.mjs (BST-2189).
//
// Layout: <reportsDir>/[<artifact>/]<job>/<report>.json. A report's job is the
// name of the directory that holds it, the key the workflow passes in
// `--results`. That survives actions/download-artifact, which writes a single
// matching artifact straight into its path but several into one subdirectory
// each.
//
// Nothing here is dropped quietly: a file that is not a Playwright JSON report,
// a report that names global errors, and a test status this reader does not
// know all come back as problems for the notifier to file.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const STATUS_OUTCOMES = new Map([
  ['expected', 'passed'],
  ['flaky', 'flaky'],
  ['unexpected', 'failed'],
]);
const SKIPPED_STATUS = 'skipped';
const TITLE_SEPARATOR = ' › ';
const ERROR_EXCERPT_LINES = 12;
const ERROR_EXCERPT_CHARS = 1200;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matches ANSI colour escapes.
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/gu;

function excerpt(text) {
  const plain = String(text).replace(ANSI_ESCAPE, '').trim();
  const lines = plain.split('\n').slice(0, ERROR_EXCERPT_LINES).join('\n');
  return lines.length > ERROR_EXCERPT_CHARS ? `${lines.slice(0, ERROR_EXCERPT_CHARS)}…` : lines;
}

function listJsonFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsonFiles(entryPath));
    } else if (entry.name.endsWith('.json')) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

/**
 * The repository path of a report's absolute rootDir: its longest trailing run
 * of path segments that is a directory of this checkout. A runner's workspace
 * prefix (/home/runner/work/brainstrike/brainstrike/, /__w/...) never is.
 */
function repoRelativeDir(rootDir, repoRoot) {
  const segments = rootDir.split(/[\\/]+/u).filter(Boolean);
  for (let start = 0; start < segments.length; start += 1) {
    const candidate = segments.slice(start).join('/');
    const absolute = path.join(repoRoot, candidate);
    if (existsSync(absolute) && statSync(absolute).isDirectory()) {
      return candidate;
    }
  }
  return;
}

function* walkSpecs(suite, describes) {
  for (const spec of suite.specs ?? []) {
    yield { describes, spec };
  }
  for (const child of suite.suites ?? []) {
    yield* walkSpecs(child, [...describes, child.title]);
  }
}

function firstError(test) {
  for (const result of test.results ?? []) {
    const message = result.error?.message ?? result.errors?.[0]?.message;
    if (message) {
      return excerpt(message);
    }
  }
  return;
}

function isPlaywrightJsonReport(report) {
  return (
    typeof report?.config?.rootDir === 'string' &&
    Array.isArray(report.suites) &&
    Array.isArray(report.errors)
  );
}

function readReport({ absolutePath, file, job, repoRoot }) {
  const tests = [];
  const problems = [];
  const problem = (reason) => problems.push({ file, job, reason });

  let report;
  try {
    report = JSON.parse(readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    problem(`is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    return { problems, tests };
  }
  if (!isPlaywrightJsonReport(report)) {
    problem('is not a Playwright JSON report');
    return { problems, tests };
  }
  for (const error of report.errors) {
    problem(`reports a run error: ${excerpt(error?.message ?? 'unknown error')}`);
  }
  const specRoot = repoRelativeDir(report.config.rootDir, repoRoot);
  if (specRoot === undefined) {
    problem(`names rootDir ${report.config.rootDir}, which is not a directory of this checkout`);
    return { problems, tests };
  }

  // A file-level suite's own title is its path, so describes start below it.
  for (const fileSuite of report.suites) {
    for (const { describes, spec } of walkSpecs(fileSuite, [])) {
      for (const test of spec.tests ?? []) {
        if (test.status === SKIPPED_STATUS) {
          continue;
        }
        const outcome = STATUS_OUTCOMES.get(test.status);
        const project = test.projectName ? [`[${test.projectName}]`] : [];
        const title = [...project, ...describes, spec.title].join(TITLE_SEPARATOR);
        if (!outcome) {
          problem(`gives "${title}" the unknown status ${JSON.stringify(test.status)}`);
          continue;
        }
        tests.push({
          error: outcome === 'passed' ? undefined : firstError(test),
          job,
          outcome,
          spec: path.posix.join(specRoot, spec.file),
          title,
        });
      }
    }
  }
  return { problems, tests };
}

/**
 * @param {{ reportsDir: string, repoRoot: string }} options
 * @returns {{
 *   tests: Array<{ job: string, spec: string, title: string,
 *                  outcome: 'failed' | 'flaky' | 'passed', error?: string }>,
 *   problems: Array<{ job: string | undefined, file: string, reason: string }>,
 *   jobsWithReports: Set<string>,
 * }}
 */
export function readNightlyTestResults({ reportsDir, repoRoot }) {
  if (!(existsSync(reportsDir) && statSync(reportsDir).isDirectory())) {
    throw new Error(`--reports directory ${reportsDir} does not exist.`);
  }
  const tests = [];
  const problems = [];
  const jobsWithReports = new Set();
  for (const absolutePath of listJsonFiles(reportsDir)) {
    const file = path.relative(reportsDir, absolutePath);
    const parent = path.dirname(file);
    if (parent === '.') {
      problems.push({ file, job: undefined, reason: 'is not inside a job directory' });
      continue;
    }
    const job = path.basename(parent);
    jobsWithReports.add(job);
    const report = readReport({ absolutePath, file, job, repoRoot });
    tests.push(...report.tests);
    problems.push(...report.problems);
  }
  return { jobsWithReports, problems, tests };
}
