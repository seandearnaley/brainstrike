// Reads the Playwright and Vitest JSON reports a nightly workflow uploaded into
// per-test outcomes for scripts/notify-linear-nightly.mjs (BST-2189, BST-2401).
//
// Layout: <reportsDir>/[<artifact>/]<job>/<part>/<file>. <job> is the key the
// workflow passes in `--results`; <part> is one job instance under it, such as
// a shard, so a red shard is judged on its own results and never hidden by a
// sibling's failing test. The layout lives inside each artifact, so it
// survives actions/download-artifact, which writes a single matching artifact
// straight into its path but several into one subdirectory each. A part holds:
//
//   <report>.json   a Playwright JSON report, one per Playwright run, or a
//                   Vitest `json` reporter report, one per package lane
//                   (test-utils vitest.base);
//   job.status      the job's own status (success, failure or cancelled),
//                   written by an always() step before the upload;
//   <lane>.unreported  a lane that failed without writing its report
//                   (scripts/run-e2e-lane-sequence.mjs), holding how it failed.
//
// Nothing here is dropped quietly: any other file, a file outside a
// <job>/<part> directory, a report that is neither format or names run
// errors, a Vitest test file that failed outside any test, and a test status
// this reader does not know all come back as problems for the notifier to file.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const STATUS_OUTCOMES = new Map([
  ['expected', 'passed'],
  ['flaky', 'flaky'],
  ['unexpected', 'failed'],
]);
const SKIPPED_STATUS = 'skipped';
// Vitest's json reporter uses Jest's assertion statuses. It records no retry,
// so a Vitest test is never flaky here.
const VITEST_OUTCOMES = new Map([
  ['passed', 'passed'],
  ['failed', 'failed'],
]);
const VITEST_NOT_RUN = new Set(['skipped', 'pending', 'todo', 'disabled']);
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

const JOB_STATUS_FILE = 'job.status';
const UNREPORTED_SUFFIX = '.unreported';
const JOB_STATUSES = new Set(['success', 'failure', 'cancelled']);

function listFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    files.push(...(entry.isDirectory() ? listFiles(entryPath) : [entryPath]));
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

function isVitestJsonReport(report) {
  return typeof report?.numTotalTests === 'number' && Array.isArray(report.testResults);
}

/** The repository path of a test file's absolute path, on any runner's OS. */
function repoRelativeFile(absoluteFile, repoRoot) {
  const segments = absoluteFile.split(/[\\/]+/u).filter(Boolean);
  const name = segments.pop();
  const dir = repoRelativeDir(segments.join('/'), repoRoot);
  return dir === undefined || name === undefined ? undefined : path.posix.join(dir, name);
}

function readVitestReport(report, { file, job, part, repoRoot }) {
  const tests = [];
  const problems = [];
  const problem = (reason) => problems.push({ file, job, reason });
  for (const testFile of report.testResults) {
    const spec = repoRelativeFile(String(testFile?.name ?? ''), repoRoot);
    if (spec === undefined) {
      problem(`names test file ${testFile?.name}, which is not a file of this checkout`);
      continue;
    }
    let failedTests = 0;
    for (const assertion of testFile.assertionResults ?? []) {
      if (VITEST_NOT_RUN.has(assertion.status)) {
        continue;
      }
      const outcome = VITEST_OUTCOMES.get(assertion.status);
      const title = [...(assertion.ancestorTitles ?? []), assertion.title].join(TITLE_SEPARATOR);
      if (!outcome) {
        problem(`gives "${title}" the unknown status ${JSON.stringify(assertion.status)}`);
        continue;
      }
      if (outcome === 'failed') {
        failedTests += 1;
      }
      const message = assertion.failureMessages?.[0];
      tests.push({
        error: outcome === 'failed' && message ? excerpt(message) : undefined,
        job,
        outcome,
        part,
        spec,
        title,
      });
    }
    // An import error or a failing hook fails the file with no failing test.
    if (testFile.status === 'failed' && failedTests === 0) {
      problem(`says ${spec} failed outside any test: ${excerpt(testFile.message || 'no message')}`);
    }
  }
  return { problems, tests };
}

function readReport({ absolutePath, file, job, part, repoRoot }) {
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
  if (isVitestJsonReport(report)) {
    return readVitestReport(report, { file, job, part, repoRoot });
  }
  if (!isPlaywrightJsonReport(report)) {
    problem('is not a Playwright or Vitest JSON report');
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
          part,
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
 *   tests: Array<{ job: string, part: string, spec: string, title: string,
 *                  outcome: 'failed' | 'flaky' | 'passed', error?: string }>,
 *   problems: Array<{ job: string | undefined, file: string, reason: string }>,
 *   parts: Map<string, { job: string, part: string, status?: string }>,
 * }} parts is keyed `<job>/<part>`.
 */
export function readNightlyTestResults({ reportsDir, repoRoot }) {
  if (!(existsSync(reportsDir) && statSync(reportsDir).isDirectory())) {
    throw new Error(`--reports directory ${reportsDir} does not exist.`);
  }
  const tests = [];
  const problems = [];
  const parts = new Map();
  const homes = new Map();
  for (const absolutePath of listFiles(reportsDir)) {
    const file = path.relative(reportsDir, absolutePath);
    const segments = file.split(path.sep);
    if (segments.length < 3 || segments.length > 4) {
      problems.push({ file, job: undefined, reason: 'is not inside a <job>/<part> directory' });
      continue;
    }
    const [job, part, name] = segments.slice(-3);
    const key = `${job}/${part}`;
    const home = segments.slice(0, -3).join('/');
    if (homes.has(key) && homes.get(key) !== home) {
      problems.push({
        file,
        job,
        reason: `repeats part ${key}, already uploaded by another artifact`,
      });
      continue;
    }
    homes.set(key, home);
    const entry = parts.get(key) ?? { job, part, status: undefined };
    parts.set(key, entry);
    if (name === JOB_STATUS_FILE) {
      const status = readFileSync(absolutePath, 'utf8').trim();
      if (JOB_STATUSES.has(status)) {
        entry.status = status;
      } else {
        problems.push({
          file,
          job,
          reason: `records the unknown job status ${JSON.stringify(status)}`,
        });
      }
    } else if (name.endsWith(UNREPORTED_SUFFIX)) {
      const lane = name.slice(0, -UNREPORTED_SUFFIX.length);
      const how = readFileSync(absolutePath, 'utf8').trim();
      problems.push({
        file,
        job,
        reason: `says lane \`${lane}\` ${how} without writing its report`,
      });
    } else if (name.endsWith('.json')) {
      const report = readReport({ absolutePath, file, job, part, repoRoot });
      tests.push(...report.tests);
      problems.push(...report.problems);
    } else {
      problems.push({ file, job, reason: 'is not a nightly results file' });
    }
  }
  return { parts, problems, tests };
}

const RESULTS_ARTIFACT_PREFIX = 'nightly-results--';
const RESULTS_JOB = /^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*$/u;

/**
 * The actions/download-artifact `pattern` for the results of `jobs` alone: each
 * job uploads `nightly-results--<job>`, or `nightly-results--<job>--<part>` per
 * part (BST-2189). Every workflow nightly.yml calls shares that run's artifacts
 * (BST-2233), so a pattern over every `nightly-results--*` would file another
 * workflow's tests as this one's. download-artifact matches with minimatch,
 * which reads a one-element brace set literally, so each job gives two.
 * @param {string[]} jobs
 */
export function resultsArtifactPattern(jobs) {
  if (jobs.length === 0) {
    throw new Error('Name at least one results job.');
  }
  for (const job of jobs) {
    // `--` separates a job from its part in the artifact name.
    if (!RESULTS_JOB.test(job)) {
      throw new Error(`results job ${JSON.stringify(job)} is not a plain artifact name segment.`);
    }
  }
  const names = jobs.flatMap((job) => [job, `${job}--*`]);
  return `${RESULTS_ARTIFACT_PREFIX}{${names.join(',')}}`;
}
