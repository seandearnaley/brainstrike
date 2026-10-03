#!/usr/bin/env node
// Offline accounting of REST run-attempt/job snapshots. Never dispatches CI.
// GitHub elapsed time and runner labels are not Ubicloud billing records.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function timestamp(value, label) {
  if (typeof value !== 'string' || !value.endsWith('Z') || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Missing or invalid ${label}: ${JSON.stringify(value)}`);
  }
  return Date.parse(value) / 1000;
}

function interval(start, end, label) {
  const range = [timestamp(start, `${label} start`), timestamp(end, `${label} completion`)];
  if (range[1] < range[0]) {
    throw new Error(`Inverted ${label} interval`);
  }
  return range;
}

function measure() {
  return { jobs: 0, roundedJobMinutes: 0, seconds: 0 };
}

function add(bucket, seconds) {
  bucket.jobs++;
  bucket.seconds += seconds;
  bucket.roundedJobMinutes += Math.ceil(seconds / 60);
}

function aggregate(map, name, seconds) {
  if (!map.has(name)) {
    map.set(name, { name, ...measure() });
  }
  add(map.get(name), seconds);
}

function sorted(map) {
  return [...map.values()].sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name));
}

export function auditMinutes(rows, options) {
  const [start, end] = interval(options.start, options.end, 'window');
  if (start === end) {
    throw new Error('Empty window');
  }
  const attempts = new Set();
  for (const row of rows) {
    const key = `${row.run_id}/${row.attempt}`;
    if (attempts.has(key)) {
      throw new Error(`Duplicate attempt ${key}`);
    }
    attempts.add(key);
  }
  if (options.runs) {
    const expected = new Set();
    for (const run of options.runs) {
      if (!Number.isInteger(run.run_attempt) || run.run_attempt < 1) {
        throw new Error(`Invalid run inventory ${run.id}`);
      }
      if (run.conclusion === 'skipped' && run.run_attempt === 1) {
        continue;
      }
      for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
        const key = `${run.id}/${attempt}`;
        expected.add(key);
        if (!attempts.has(key)) {
          throw new Error(`Missing attempt ${key}`);
        }
      }
    }
    for (const key of attempts) {
      if (!expected.has(key)) {
        throw new Error(`Unexpected attempt ${key}`);
      }
    }
  }
  const seen = new Set();
  const workflows = new Map();
  const jobs = new Map();
  const events = new Map();
  const conclusions = new Map();
  const labels = new Map();
  const days = new Map();
  const steps = new Map();
  const total = { ...measure(), outsideStepsSeconds: 0, overlappingStepSeconds: 0, stepSeconds: 0 };
  const reruns = measure();
  const longestJobs = [];
  const incompleteSteps = [];
  let unallocatedJobs = 0;
  for (const row of rows) {
    if (!Number.isInteger(row.attempt) || row.attempt < 1 || !Array.isArray(row.jobs)) {
      throw new Error(`Invalid run-attempt snapshot ${row.run_id}`);
    }
    for (const job of row.jobs) {
      const runnerLabels = job.labels.filter((label) => label.startsWith('ubicloud-'));
      if (runnerLabels.length === 0) {
        continue;
      }
      if (!job.runner_name) {
        unallocatedJobs++;
        continue;
      }
      if (seen.has(job.id)) {
        throw new Error(`Duplicate job ${job.id}`);
      }
      seen.add(job.id);
      const [jobStart, jobEnd] = interval(job.started_at, job.completed_at, `job ${job.id}`);
      if (jobEnd < start || jobEnd >= end) {
        continue;
      }
      if (job.status !== 'completed' || !job.conclusion) {
        throw new Error(`Incomplete job ${job.id}`);
      }
      const seconds = jobEnd - jobStart;
      add(total, seconds);
      if (row.attempt > 1) {
        add(reruns, seconds);
      }
      aggregate(workflows, row.workflow, seconds);
      aggregate(jobs, job.name, seconds);
      aggregate(events, row.event, seconds);
      aggregate(conclusions, job.conclusion, seconds);
      aggregate(labels, runnerLabels.join(', '), seconds);
      aggregate(days, job.completed_at.slice(0, 10), seconds);
      const activeSteps = [];
      for (const step of job.steps) {
        if (step.conclusion === 'skipped') {
          continue;
        }
        if (!(step.started_at && step.completed_at)) {
          incompleteSteps.push({
            completedAt: step.completed_at,
            conclusion: step.conclusion,
            jobId: job.id,
            name: step.name,
            startedAt: step.started_at,
          });
          continue;
        }
        const range = interval(
          step.started_at,
          step.completed_at,
          `job ${job.id} step ${step.name}`
        );
        const stepStart = Math.max(jobStart, range[0]);
        const stepEnd = Math.min(jobEnd, range[1]);
        if (stepEnd <= stepStart) {
          continue;
        }
        activeSteps.push([stepStart, stepEnd]);
        aggregate(steps, step.name, stepEnd - stepStart);
      }
      activeSteps.sort((a, b) => a[0] - b[0]);
      let coveredUntil = jobStart;
      let covered = 0;
      let sum = 0;
      for (const [stepStart, stepEnd] of activeSteps) {
        sum += stepEnd - stepStart;
        covered += Math.max(0, stepEnd - Math.max(stepStart, coveredUntil));
        coveredUntil = Math.max(coveredUntil, stepEnd);
      }
      total.stepSeconds += covered;
      total.overlappingStepSeconds += sum - covered;
      total.outsideStepsSeconds += seconds - covered;
      longestJobs.push({
        attempt: row.attempt,
        conclusion: job.conclusion,
        id: job.id,
        name: job.name,
        runId: row.run_id,
        seconds,
        url: `https://github.com/seandearnaley/brainstrike/actions/runs/${row.run_id}/job/${job.id}`,
        workflow: row.workflow,
      });
    }
  }
  total.roundingSeconds = total.roundedJobMinutes * 60 - total.seconds;
  return {
    attemptCoverageVerified: Boolean(options.runs),
    attemptSnapshots: rows.length,
    caveat:
      'GitHub execution and rounded-job estimates, not provider-billed minutes or proof of hangs. Verification covers attempts in the supplied inventory, not deleted or omitted runs. Step buckets can overlap; total.stepSeconds uses their union. Labels do not identify premium routing.',
    conclusions: sorted(conclusions),
    days: sorted(days),
    events: sorted(events),
    incompleteSteps,
    inventoryRuns: options.runs?.length ?? null,
    jobs: sorted(jobs),
    labels: sorted(labels),
    longestJobs: longestJobs.sort((a, b) => b.seconds - a.seconds).slice(0, 25),
    reruns,
    steps: sorted(steps),
    total,
    unallocatedJobs,
    window: { basis: 'job completion in UTC', end: options.end, start: options.start },
    workflows: sorted(workflows),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const [, , file, start, end, inventory, ...extra] = process.argv;
    if (!(file && start && end && inventory) || extra.length) {
      throw new Error(
        'Usage: node scripts/audit-ci-minutes.mjs <attempt-jobs.json> <start-UTC> <end-UTC-exclusive> <run-inventory.json>'
      );
    }
    const runs = JSON.parse(readFileSync(inventory, 'utf8'));
    console.log(
      JSON.stringify(
        auditMinutes(JSON.parse(readFileSync(file, 'utf8')), { end, runs, start }),
        null,
        2
      )
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
