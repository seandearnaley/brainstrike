#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { runBoundedProcess } from '../shared/bounded-process.mjs';
import { writeJsonAtomic } from '../shared/shadow-report.mjs';
import { runContractDriftGuardian } from './index.mjs';

const output = process.env.REPORT_PATH ?? 'reports/agent-routines/contract-drift-guardian.json';
const headSha =
  process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
let report;
try {
  report = await runContractDriftGuardian({ headSha, runner: runBoundedProcess });
} catch (error) {
  report = {
    completedAt: new Date().toISOString(),
    error: String(error),
    executions: [],
    findings: [],
    headSha,
    routine: 'contract-drift-guardian',
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
