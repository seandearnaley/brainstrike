#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runBoundedProcess } from '../shared/bounded-process.mjs';
import { writeJsonAtomic } from '../shared/shadow-report.mjs';
import { loadUnitPartition, runCiFlakeInvestigator } from './index.mjs';

const output = process.env.REPORT_PATH ?? 'reports/agent-routines/ci-flake-investigator.json';
const headSha =
  process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const shard = process.env.UNIT_SHARD;
let report;
try {
  if (!shard) {
    throw new Error('UNIT_SHARD is required');
  }
  const workflow = readFileSync('.github/workflows/test.yml', 'utf8');
  report = await runCiFlakeInvestigator({
    headSha,
    partition: loadUnitPartition(workflow, shard),
    runner: runBoundedProcess,
  });
} catch (error) {
  report = {
    completedAt: new Date().toISOString(),
    error: String(error),
    executions: [],
    findings: [],
    headSha,
    routine: 'ci-flake-investigator',
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    status: 'harness-error',
    summary: { executions: 0, findings: 0, omittedFindings: 0 },
  };
}
await writeJsonAtomic(path.resolve(output), report);
console.log(JSON.stringify(report));
if (report.status === 'incomplete' || report.status === 'harness-error') {
  process.exitCode = 2;
}
