import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBoundedProcess } from './agent-routines/shared/bounded-process.mjs';
import {
  freezeCurrentOriginMain,
  readCurrentHeadSha,
} from './agent-routines/shared/current-main.mjs';
import { createRoutineResultWriter } from './agent-routines/shared/routine-result.mjs';
import { fingerprint } from './agent-routines/shared/shadow-report.mjs';

export const MUTATION_TARGET = 'packages/file-system/src/path-validation.ts';
export const MUTATION_MAX_FINDINGS = 25;
const PACKAGE_RELATIVE_TARGET = 'src/path-validation.ts';
const KNOWN_STATUSES = new Set(['Killed', 'Survived', 'NoCoverage', 'CompileError', 'Timeout']);

function harnessError(reason) {
  return {
    classification: 'harness-error',
    findings: [],
    reasons: [reason],
    totals: {
      compileError: 0,
      killed: 0,
      mutationTimeout: 0,
      survivingMutant: 0,
      total: 0,
      uncoveredMutant: 0,
    },
  };
}

function normalizedTarget(file) {
  const portable = file.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (portable === PACKAGE_RELATIVE_TARGET || portable === MUTATION_TARGET) {
    return MUTATION_TARGET;
  }
  return portable;
}

function isValidPosition(position) {
  return (
    position !== null &&
    typeof position === 'object' &&
    Number.isSafeInteger(position.line) &&
    position.line > 0 &&
    Number.isSafeInteger(position.column) &&
    position.column >= 0
  );
}

function isValidMutantSchema(mutant) {
  const start = mutant?.location?.start;
  const end = mutant?.location?.end;
  return (
    isValidPosition(start) &&
    isValidPosition(end) &&
    (start.line < end.line || (start.line === end.line && start.column <= end.column)) &&
    typeof mutant.mutatorName === 'string' &&
    mutant.mutatorName.length > 0 &&
    typeof mutant.replacement === 'string'
  );
}

function stableIdentity(file, mutant) {
  const start = mutant.location.start;
  const end = mutant.location.end;
  return `${file}:${start.line}:${start.column}-${end.line}:${end.column}:${mutant.mutatorName}:${mutant.replacement}`;
}

function compareMutants(left, right) {
  const leftLocation = left.location;
  const rightLocation = right.location;
  return (
    leftLocation.start.line - rightLocation.start.line ||
    leftLocation.start.column - rightLocation.start.column ||
    leftLocation.end.line - rightLocation.end.line ||
    leftLocation.end.column - rightLocation.end.column ||
    left.mutatorName.localeCompare(right.mutatorName) ||
    left.replacement.localeCompare(right.replacement)
  );
}

export function classifyMutationReport(report) {
  if (!report || typeof report !== 'object' || !report.files || typeof report.files !== 'object') {
    return harnessError('Stryker JSON report is missing or malformed');
  }
  const entries = Object.entries(report.files);
  if (entries.length !== 1 || normalizedTarget(entries[0][0]) !== MUTATION_TARGET) {
    return harnessError('Stryker report target is outside the exact mutation allowlist');
  }
  const mutants = entries[0][1]?.mutants;
  if (!Array.isArray(mutants) || mutants.length === 0) {
    return harnessError('Stryker generated zero mutants');
  }
  const ids = new Set();
  const stableIdentities = new Set();
  for (const mutant of mutants) {
    if (typeof mutant?.id !== 'string' || ids.has(mutant.id)) {
      return harnessError('Stryker mutant IDs are missing or duplicated');
    }
    ids.add(mutant.id);
    if (!isValidMutantSchema(mutant)) {
      return harnessError('Stryker mutant schema is malformed');
    }
    const identity = stableIdentity(MUTATION_TARGET, mutant);
    if (stableIdentities.has(identity)) {
      return harnessError('Stryker stable mutation identities are duplicated');
    }
    stableIdentities.add(identity);
    if (!KNOWN_STATUSES.has(mutant.status)) {
      return {
        ...harnessError(`unknown Stryker mutant status: ${String(mutant.status)}`),
        classification: 'incomplete',
      };
    }
  }

  const totals = {
    compileError: 0,
    killed: 0,
    mutationTimeout: 0,
    survivingMutant: 0,
    total: mutants.length,
    uncoveredMutant: 0,
  };
  const findings = [];
  for (const mutant of [...mutants].sort(compareMutants)) {
    let kind;
    if (mutant.status === 'Killed') {
      totals.killed += 1;
    } else if (mutant.status === 'CompileError') {
      totals.compileError += 1;
    } else if (mutant.status === 'Survived') {
      totals.survivingMutant += 1;
      kind = 'surviving-mutant';
    } else if (mutant.status === 'NoCoverage') {
      totals.uncoveredMutant += 1;
      kind = 'uncovered-mutant';
    } else if (mutant.status === 'Timeout') {
      totals.mutationTimeout += 1;
      kind = 'mutation-timeout';
    }
    if (kind) {
      const identity = stableIdentity(MUTATION_TARGET, mutant);
      findings.push({
        file: MUTATION_TARGET,
        fingerprint: createHash('sha256').update(identity).digest('hex'),
        kind,
        location: mutant.location,
        mutatorName: mutant.mutatorName,
        replacement: mutant.replacement,
      });
    }
  }
  return {
    classification: findings.length > 0 ? 'report' : 'no-change',
    findings: findings.slice(0, MUTATION_MAX_FINDINGS),
    totals,
  };
}

export function classifyMutationRun({ processResult, rawReport }) {
  if (!processResult || typeof processResult !== 'object') {
    return { ...harnessError('Stryker process result is missing'), classification: 'incomplete' };
  }
  if (
    processResult.terminationFailed ||
    processResult.timedOut ||
    processResult.signal ||
    processResult.exitCode !== 0
  ) {
    const reason = processResult.terminationFailed
      ? 'Stryker process termination could not be verified'
      : processResult.timedOut
        ? 'Stryker command timed out'
        : processResult.signal
          ? 'Stryker process crashed'
          : `Stryker command exited nonzero: ${String(processResult.exitCode)}`;
    return { ...harnessError(reason), classification: 'incomplete' };
  }
  return classifyMutationReport(rawReport);
}

export function mutationRunExitCode(report) {
  return ['harness-error', 'incomplete'].includes(report?.classification) ? 1 : 0;
}

async function spawnStryker({ repoRoot, timeoutMs }) {
  const result = await runBoundedProcess({
    command: [
      'pnpm',
      '--dir',
      'packages/file-system',
      'exec',
      'stryker',
      'run',
      'stryker.shadow.config.cjs',
    ],
    cwd: repoRoot,
    timeoutMs,
  });
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    terminationFailed: result.outcome === 'termination-failed',
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

export async function runMutationGapHardener(options = {}) {
  const { baseSha, repoRoot, spawn = spawnStryker, timeoutMs = 35 * 60 * 1000 } = options;
  validateRunInputs({ baseSha, repoRoot });
  const reportDir =
    options.reportDir ?? path.join(repoRoot, 'reports/shadow/mutation-gap-hardener');
  await mkdir(reportDir, { recursive: true });
  const processResult = await spawn({ repoRoot, timeoutMs });
  const rawReportPath = path.join(
    repoRoot,
    'packages/file-system/reports/shadow/mutation-gap.json'
  );
  let rawReport = null;
  try {
    rawReport = JSON.parse(await readFile(rawReportPath, 'utf8'));
  } catch {
    rawReport = null;
  }
  const report = classifyMutationRun({ processResult, rawReport });
  const normalized = { baseSha, routineId: 'mutation-gap-hardener', ...report };
  await writeFile(path.join(reportDir, 'report.json'), `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const terminalWriter = createRoutineResultWriter();
  const reportDir = path.join(repoRoot, 'reports/shadow/mutation-gap-hardener');
  let baseSha = /^[0-9a-f]{40}$/u.test(process.env.GITHUB_SHA ?? '')
    ? process.env.GITHUB_SHA
    : '0'.repeat(40);
  let terminalResult;
  try {
    baseSha = await readCurrentHeadSha({ cwd: repoRoot });
    baseSha = await freezeCurrentOriginMain({ cwd: repoRoot });
    const report = await runMutationGapHardener({ baseSha, repoRoot, reportDir });
    if (report.classification === 'no-change') {
      terminalResult = {
        baseSha,
        fingerprint: fingerprint(['mutation-gap-hardener', baseSha, 'no-change']),
        status: 'no-change',
      };
    } else if (report.classification === 'report') {
      terminalResult = {
        baseSha,
        fingerprint: fingerprint([
          'mutation-gap-hardener',
          baseSha,
          ...report.findings.map(({ fingerprint }) => fingerprint),
        ]),
        status: 'report',
        summary: `${report.findings.length} mutation gap(s) reported`,
      };
    } else {
      terminalResult = {
        baseSha,
        fingerprint: fingerprint(['mutation-gap-hardener', baseSha, report.classification]),
        reasons: [`mutation hardener ended as ${report.classification}`],
        status: 'blocked',
      };
    }
  } catch (error) {
    const reason = String(error);
    await mkdir(reportDir, { recursive: true });
    await writeFile(
      path.join(reportDir, 'report.json'),
      `${JSON.stringify({ baseSha, classification: 'harness-error', error: reason, routineId: 'mutation-gap-hardener' }, null, 2)}\n`
    );
    terminalResult = {
      baseSha,
      fingerprint: fingerprint(['mutation-gap-hardener', baseSha, 'blocked', reason]),
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
