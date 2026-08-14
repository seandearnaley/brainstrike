#!/usr/bin/env node
import path from 'node:path';
import { runBoundedProcess } from '../shared/bounded-process.mjs';
import { freezeCurrentOriginMain, readCurrentHeadSha } from '../shared/current-main.mjs';
import { createRoutineResultWriter } from '../shared/routine-result.mjs';
import { fingerprint, writeJsonAtomic } from '../shared/shadow-report.mjs';
import { runContractDriftGuardian } from './index.mjs';

const output = process.env.REPORT_PATH ?? 'reports/agent-routines/contract-drift-guardian.json';
const terminalWriter = createRoutineResultWriter();
const unknownSha = '0'.repeat(40);
let baseSha = /^[0-9a-f]{40}$/u.test(process.env.GITHUB_SHA ?? '')
  ? process.env.GITHUB_SHA
  : unknownSha;
let report;
let terminalResult;
try {
  baseSha = await readCurrentHeadSha();
  baseSha = await freezeCurrentOriginMain();
  report = await runContractDriftGuardian({ headSha: baseSha, runner: runBoundedProcess });
  if (report.status === 'clean') {
    terminalResult = {
      baseSha,
      fingerprint: fingerprint(['contract-drift-guardian', baseSha, 'clean']),
      status: 'no-change',
    };
  } else if (report.status === 'findings') {
    terminalResult = {
      baseSha,
      fingerprint: fingerprint([
        'contract-drift-guardian',
        baseSha,
        ...report.findings.map(({ fingerprint }) => fingerprint),
      ]),
      status: 'report',
      summary: `${report.findings.length} contract drift finding(s)`,
    };
  } else {
    terminalResult = {
      baseSha,
      fingerprint: fingerprint(['contract-drift-guardian', baseSha, report.status]),
      reasons: [`contract guardian ended as ${report.status}`],
      status: 'blocked',
    };
  }
} catch (error) {
  const reason = String(error);
  report = {
    baseSha,
    completedAt: new Date().toISOString(),
    error: reason,
    executions: [],
    findings: [],
    routine: 'contract-drift-guardian',
    schemaVersion: 2,
    startedAt: new Date().toISOString(),
    status: 'harness-error',
    summary: { executions: 0, findings: 0, omittedFindings: 0 },
  };
  terminalResult = {
    baseSha,
    fingerprint: fingerprint(['contract-drift-guardian', baseSha, 'blocked', reason]),
    reasons: [reason],
    status: 'blocked',
  };
}
try {
  await writeJsonAtomic(path.resolve(output), report);
} catch (error) {
  terminalResult = {
    baseSha,
    fingerprint: fingerprint(['contract-drift-guardian', baseSha, 'report-write-failed']),
    reasons: [`failed to write diagnostic report: ${String(error)}`],
    status: 'blocked',
  };
}
terminalWriter.write(terminalResult);
terminalWriter.assertWritten();
if (terminalResult.status === 'blocked') {
  process.exitCode = 2;
}
