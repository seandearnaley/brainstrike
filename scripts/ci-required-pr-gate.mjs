#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const TERMINAL_FAILURE_RESULTS = new Set(['failure', 'cancelled', 'timed_out']);

function parseRequiredJobs(value) {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((job) => typeof job !== 'string')) {
      throw new Error('expected a JSON string array');
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`REQUIRED_JOBS_JSON must be a JSON string array: ${message}`);
  }
}

export function parseRequiredPrGateEnv(env = process.env) {
  if (!env.REQUIRED_NEEDS) {
    throw new Error('REQUIRED_NEEDS is required');
  }
  if (!env.REQUIRED_JOBS_JSON) {
    throw new Error('REQUIRED_JOBS_JSON is required');
  }
  return {
    needs: JSON.parse(env.REQUIRED_NEEDS),
    requiredJobs: parseRequiredJobs(env.REQUIRED_JOBS_JSON),
  };
}

export function verifyRequiredPrGate({ needs, requiredJobs }) {
  const failures = [];
  const required = new Set(requiredJobs);

  if (!required.has('plan')) {
    failures.push('CI Plan did not mark plan as required');
  }

  for (const [name, job] of Object.entries(needs)) {
    if (TERMINAL_FAILURE_RESULTS.has(job.result)) {
      failures.push(`${name}: ${job.result}`);
    }
  }

  for (const jobName of required) {
    if (needs[jobName]?.result !== 'success') {
      failures.push(`${jobName}: ${needs[jobName]?.result ?? 'missing'}`);
    }
  }

  for (const [name, job] of Object.entries(needs)) {
    if (!required.has(name) && job.result === 'success') {
      failures.push(`${name}: ran successfully but was not selected by CI Plan`);
    }
  }

  return failures;
}

export function runRequiredPrGate(env = process.env) {
  const failures = verifyRequiredPrGate(parseRequiredPrGateEnv(env));
  if (failures.length > 0) {
    console.error('Required PR gate failed:');
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    return 1;
  }
  console.log('Required PR gate passed.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = runRequiredPrGate();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Required PR gate crashed: ${message}`);
    process.exitCode = 1;
  }
}
