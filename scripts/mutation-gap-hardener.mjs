import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  for (const mutant of mutants) {
    if (typeof mutant?.id !== 'string' || ids.has(mutant.id)) {
      return harnessError('Stryker mutant IDs are missing or duplicated');
    }
    ids.add(mutant.id);
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
  if (processResult.timedOut || processResult.signal || processResult.exitCode !== 0) {
    const reason = processResult.timedOut
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

export function assertMutationPromotionPatchAllowed(changedFiles) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    throw new Error('a future mutation promotion must contain at least one test change');
  }
  const exactTest = 'packages/file-system/src/__tests__/path-validation.test.ts';
  for (const file of changedFiles) {
    const portable = typeof file === 'string' ? file.replaceAll('\\', '/') : '';
    const helper = /^packages\/file-system\/src\/__tests__\/[a-z0-9][a-z0-9.-]*\.(?:ts|tsx)$/u.test(
      portable
    );
    if (portable !== exactTest && !helper) {
      throw new Error(`mutation promotion contains a non-test change: ${String(file)}`);
    }
  }
}

function spawnStryker({ repoRoot, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(
      'pnpm',
      ['--dir', 'packages/file-system', 'exec', 'stryker', 'run', 'stryker.shadow.config.cjs'],
      { cwd: repoRoot, stdio: 'inherit' }
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('exit', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut });
    });
  });
}

export async function runMutationGapHardener({
  repoRoot,
  reportDir = path.join(repoRoot, 'reports/shadow/mutation-gap-hardener'),
  timeoutMs = 35 * 60 * 1000,
} = {}) {
  await mkdir(reportDir, { recursive: true });
  const processResult = await spawnStryker({ repoRoot, timeoutMs });
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
  const normalized = { routineId: 'mutation-gap-hardener', ...report };
  await writeFile(path.join(reportDir, 'report.json'), `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const report = await runMutationGapHardener({ repoRoot });
  process.exitCode = mutationRunExitCode(report);
}
