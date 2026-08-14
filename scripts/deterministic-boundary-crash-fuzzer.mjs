import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBoundedProcess } from './agent-routines/shared/bounded-process.mjs';
import {
  freezeCurrentOriginMain,
  readCurrentHeadSha,
} from './agent-routines/shared/current-main.mjs';
import { createRoutineResultWriter } from './agent-routines/shared/routine-result.mjs';
import { fingerprint as terminalFingerprint } from './agent-routines/shared/shadow-report.mjs';

export const BOUNDARY_FUZZ_SEED = 0x42_53_54_52;
export const BOUNDARY_CASE_COUNTS = Object.freeze({
  parserEnvelope: 256,
  parserSource: 1024,
  path: 512,
  runVerdict: 256,
});
export const BOUNDARY_MAX_FINDINGS = 100;

const CASE_GROUPS = [
  ['path', BOUNDARY_CASE_COUNTS.path],
  ['run-verdict', BOUNDARY_CASE_COUNTS.runVerdict],
  ['parser-envelope', BOUNDARY_CASE_COUNTS.parserEnvelope],
  ['parser-source', BOUNDARY_CASE_COUNTS.parserSource],
];

function xorshift32(value) {
  let state = value >>> 0;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
}

export function createDeterministicCaseIds(seed = BOUNDARY_FUZZ_SEED) {
  let state = seed >>> 0;
  const ids = [];
  for (const [group, count] of CASE_GROUPS) {
    for (let index = 0; index < count; index += 1) {
      state = xorshift32(state);
      ids.push(`${group}:${String(index).padStart(4, '0')}:${state.toString(16).padStart(8, '0')}`);
    }
  }
  return ids;
}

function fingerprint(value) {
  return createHash('sha256').update(value).digest('hex');
}

function collectAssertions(report) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.testResults)) {
    return null;
  }
  const assertions = [];
  for (const result of report.testResults) {
    if (!result || typeof result !== 'object' || !Array.isArray(result.assertionResults)) {
      return null;
    }
    assertions.push(...result.assertionResults);
  }
  return assertions;
}

export function classifyBoundaryRun({ expectedCaseIds, processResult, vitestReport }) {
  const expected = new Set(expectedCaseIds);
  const assertions = collectAssertions(vitestReport);
  let classification = 'no-change';
  const findings = [];

  if (processResult.timedOut) {
    classification = 'incomplete';
  } else if (processResult.signal || assertions === null) {
    classification = 'parser-process-crash';
  } else {
    const seen = new Set();
    let duplicateCaseCount = 0;
    for (const assertion of assertions) {
      const caseId = typeof assertion?.title === 'string' ? assertion.title : '';
      if (!expected.has(caseId)) {
        continue;
      }
      if (seen.has(caseId)) {
        duplicateCaseCount += 1;
      }
      seen.add(caseId);
      if (assertion.status !== 'passed') {
        findings.push({
          caseId,
          fingerprint: fingerprint(`${caseId}:${assertion.status ?? 'unknown'}`),
          kind: 'boundary-counterexample',
        });
      }
    }
    if (
      seen.size !== expected.size ||
      duplicateCaseCount > 0 ||
      (processResult.exitCode !== 0 && findings.length === 0)
    ) {
      classification = 'incomplete';
    } else if (findings.length > 0) {
      classification = 'boundary-counterexample';
    }
    return {
      classification,
      counts: { executed: seen.size, expected: expected.size, findings: findings.length },
      findings: findings.slice(0, BOUNDARY_MAX_FINDINGS),
    };
  }

  return {
    classification,
    counts: { executed: assertions?.length ?? 0, expected: expected.size, findings: 0 },
    findings,
  };
}

export function boundaryRunExitCode(report) {
  return ['harness-error', 'incomplete', 'parser-process-crash'].includes(report?.classification)
    ? 1
    : 0;
}

async function spawnVitest({ cwd, outputFile, timeoutMs }) {
  const args = [
    '--dir',
    'apps/desktop',
    'exec',
    'vitest',
    'run',
    'src/__tests__/assistant-server/deterministic-boundary-crash-fuzzer.test.ts',
    '--reporter=json',
    `--outputFile=${outputFile}`,
    '--pool=forks',
    '--maxWorkers=1',
    '--no-file-parallelism',
  ];
  const result = await runBoundedProcess({ command: ['pnpm', ...args], cwd, timeoutMs });
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.outcome === 'timed-out',
  };
}

function validateRunInputs({ baseSha, repoRoot }) {
  if (!/^[0-9a-f]{40}$/u.test(baseSha)) {
    throw new Error('baseSha must be a full lowercase Git SHA');
  }
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot)) {
    throw new Error('repoRoot must be an absolute path');
  }
}

export async function runBoundaryCrashFuzzer(options = {}) {
  const { baseSha, repoRoot, spawn = spawnVitest, timeoutMs = 5 * 60 * 1000 } = options;
  validateRunInputs({ baseSha, repoRoot });
  const reportDir =
    options.reportDir ?? path.join(repoRoot, 'reports/shadow/boundary-crash-fuzzer');
  await mkdir(reportDir, { recursive: true });
  const rawReportPath = path.join(reportDir, 'vitest.json');
  await rm(rawReportPath, { force: true });
  const processResult = await spawn({ cwd: repoRoot, outputFile: rawReportPath, timeoutMs });
  let vitestReport = null;
  try {
    vitestReport = JSON.parse(await readFile(rawReportPath, 'utf8'));
  } catch {
    vitestReport = null;
  }
  const report = {
    baseSha,
    routineId: 'boundary-crash-fuzzer',
    seed: BOUNDARY_FUZZ_SEED,
    ...classifyBoundaryRun({
      expectedCaseIds: createDeterministicCaseIds(),
      processResult,
      vitestReport,
    }),
  };
  await writeFile(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const terminalWriter = createRoutineResultWriter();
  const reportDir = path.join(repoRoot, 'reports/shadow/boundary-crash-fuzzer');
  let baseSha = /^[0-9a-f]{40}$/u.test(process.env.GITHUB_SHA ?? '')
    ? process.env.GITHUB_SHA
    : '0'.repeat(40);
  let terminalResult;
  try {
    baseSha = await readCurrentHeadSha({ cwd: repoRoot });
    baseSha = await freezeCurrentOriginMain({ cwd: repoRoot });
    const report = await runBoundaryCrashFuzzer({ baseSha, repoRoot, reportDir });
    if (report.classification === 'no-change') {
      terminalResult = {
        baseSha,
        fingerprint: terminalFingerprint(['boundary-crash-fuzzer', baseSha, 'no-change']),
        status: 'no-change',
      };
    } else if (report.classification === 'boundary-counterexample') {
      terminalResult = {
        baseSha,
        fingerprint: terminalFingerprint([
          'boundary-crash-fuzzer',
          baseSha,
          ...report.findings.map(({ fingerprint }) => fingerprint),
        ]),
        status: 'report',
        summary: `${report.counts.findings} boundary counterexample(s)`,
      };
    } else {
      terminalResult = {
        baseSha,
        fingerprint: terminalFingerprint(['boundary-crash-fuzzer', baseSha, report.classification]),
        reasons: [`boundary fuzzer ended as ${report.classification}`],
        status: 'blocked',
      };
    }
  } catch (error) {
    const reason = String(error);
    await mkdir(reportDir, { recursive: true });
    await writeFile(
      path.join(reportDir, 'report.json'),
      `${JSON.stringify({ baseSha, classification: 'harness-error', error: reason, routineId: 'boundary-crash-fuzzer' }, null, 2)}\n`
    );
    terminalResult = {
      baseSha,
      fingerprint: terminalFingerprint(['boundary-crash-fuzzer', baseSha, 'blocked', reason]),
      reasons: [reason],
      status: 'blocked',
    };
  }
  terminalWriter.write(terminalResult);
  terminalWriter.assertWritten();
  if (terminalResult.status === 'blocked') {
    process.exitCode = 1;
  }
}
