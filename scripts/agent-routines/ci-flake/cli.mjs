#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runBoundedProcess } from '../shared/bounded-process.mjs';
import { freezeCurrentOriginMain, readCurrentHeadSha } from '../shared/current-main.mjs';
import { createRoutineResultWriter } from '../shared/routine-result.mjs';
import { fingerprint, writeJsonAtomic } from '../shared/shadow-report.mjs';
import { fetchCurrentMainFailureMetadata } from './github-actions.mjs';
import { runCiFlakeInvestigator, selectQualifyingUnitFailure } from './index.mjs';

const output = process.env.REPORT_PATH ?? 'reports/agent-routines/ci-flake-investigator.json';
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
  const metadata = await fetchCurrentMainFailureMetadata({
    baseSha,
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN,
  });
  const candidate = selectQualifyingUnitFailure({ baseSha, ...metadata });
  report = await runCiFlakeInvestigator({
    baseSha,
    candidate,
    runner: runBoundedProcess,
    workflowText: readFileSync('.github/workflows/test.yml', 'utf8'),
  });
  if (report.status === 'clean') {
    terminalResult = {
      baseSha,
      fingerprint: fingerprint([
        'ci-flake-investigator',
        baseSha,
        report.classification,
        String(report.selected?.runId ?? 'none'),
      ]),
      status: 'no-change',
    };
  } else if (report.status === 'findings') {
    terminalResult = {
      baseSha,
      fingerprint: report.findings[0].fingerprint,
      status: 'report',
      summary: `${report.selected.shard}/${report.selected.phase}: ${report.classification}`,
    };
  } else {
    terminalResult = {
      baseSha,
      fingerprint: fingerprint(['ci-flake-investigator', baseSha, report.classification]),
      reasons: [`flake investigation ended as ${report.classification}`],
      status: 'blocked',
    };
  }
} catch (error) {
  const reason = String(error);
  report = {
    baseSha,
    classification: 'harness-error',
    completedAt: new Date().toISOString(),
    error: reason,
    executions: [],
    findings: [],
    routine: 'ci-flake-investigator',
    schemaVersion: 2,
    selected: null,
    startedAt: new Date().toISOString(),
    status: 'harness-error',
    summary: { executions: 0, findings: 0, omittedFindings: 0 },
  };
  terminalResult = {
    baseSha,
    fingerprint: fingerprint(['ci-flake-investigator', baseSha, 'blocked', reason]),
    reasons: [reason],
    status: 'blocked',
  };
}
try {
  await writeJsonAtomic(path.resolve(output), report);
} catch (error) {
  terminalResult = {
    baseSha,
    fingerprint: fingerprint(['ci-flake-investigator', baseSha, 'report-write-failed']),
    reasons: [`failed to write diagnostic report: ${String(error)}`],
    status: 'blocked',
  };
}
terminalWriter.write(terminalResult);
terminalWriter.assertWritten();
if (terminalResult.status === 'blocked') {
  process.exitCode = 2;
}
