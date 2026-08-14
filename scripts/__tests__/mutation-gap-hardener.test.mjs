import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  classifyMutationReport,
  MUTATION_TARGET,
  mutationRunExitCode,
  runMutationGapHardener,
} from '../mutation-gap-hardener.mjs';

const require = createRequire(import.meta.url);

function mutant(id, status, overrides = {}) {
  return {
    id,
    location: { end: { column: 4, line: 1 }, start: { column: 1, line: 1 } },
    mutatorName: 'ConditionalExpression',
    replacement: 'false',
    status,
    ...overrides,
  };
}

function report(mutants, file = 'src/path-validation.ts') {
  return { files: { [file]: { mutants, source: 'export const value = true;' } } };
}

describe('mutation gap hardener', () => {
  it('classifies every supported Stryker status from machine JSON', () => {
    const result = classifyMutationReport(
      report(
        [
          mutant('killed', 'Killed'),
          mutant('survived', 'Survived'),
          mutant('uncovered', 'NoCoverage'),
          mutant('compile', 'CompileError'),
          mutant('timeout', 'Timeout'),
        ].map((value, index) => ({
          ...value,
          location: {
            end: { column: 4, line: index + 1 },
            start: { column: 1, line: index + 1 },
          },
        }))
      )
    );

    assert.equal(MUTATION_TARGET, 'packages/file-system/src/path-validation.ts');
    assert.equal(result.classification, 'report');
    assert.deepEqual(result.totals, {
      compileError: 1,
      killed: 1,
      mutationTimeout: 1,
      survivingMutant: 1,
      total: 5,
      uncoveredMutant: 1,
    });
    assert.deepEqual(
      result.findings.map((finding) => finding.kind),
      ['surviving-mutant', 'uncovered-mutant', 'mutation-timeout']
    );
  });

  it('uses an isolated reporter overlay without lowering the repository config', () => {
    const base = require('../../packages/file-system/stryker.config.cjs');
    const shadow = require('../../packages/file-system/stryker.shadow.config.cjs');

    assert.equal(base.thresholds.break, 50);
    assert.equal(shadow.thresholds.break, 0);
    assert.equal(shadow.concurrency, 1);
    assert.deepEqual(shadow.mutate, ['src/path-validation.ts']);
    assert.deepEqual(shadow.reporters, ['json', 'html', 'clear-text']);
    assert.equal(shadow.jsonReporter.fileName, 'reports/shadow/mutation-gap.json');
    assert.equal(shadow.htmlReporter.fileName, 'reports/shadow/mutation-gap.html');
    assert.equal(shadow.testRunner, base.testRunner);
    assert.equal(shadow.vitest.configFile, 'vitest.mutation.shadow.config.ts');
    assert.equal(shadow.coverageAnalysis, base.coverageAnalysis);
    assert.equal(shadow.timeoutMS, 120_000);
  });

  it('fails closed for zero mutants, duplicate IDs, wrong targets, and unknown statuses', () => {
    assert.equal(classifyMutationReport(report([])).classification, 'harness-error');
    assert.equal(
      classifyMutationReport(report([mutant('same', 'Killed'), mutant('same', 'Survived')]))
        .classification,
      'harness-error'
    );
    assert.equal(
      classifyMutationReport(report([mutant('wrong', 'Killed')], 'src/other.ts')).classification,
      'harness-error'
    );
    assert.equal(
      classifyMutationReport(report([mutant('unknown', 'Pending')])).classification,
      'incomplete'
    );
  });

  it('rejects duplicate stable mutation identities even when Stryker IDs differ', () => {
    const result = classifyMutationReport(
      report([mutant('transient-1', 'Killed'), mutant('transient-2', 'Survived')])
    );

    assert.equal(result.classification, 'harness-error');
    assert.deepEqual(result.reasons, ['Stryker stable mutation identities are duplicated']);
  });

  it('normalizes malformed mutant locations, mutators, and replacements as harness errors', () => {
    const malformed = [
      mutant('location', 'Survived', { location: null }),
      mutant('line', 'Survived', {
        location: { end: { column: 4, line: 1 }, start: { column: 1, line: 0 } },
      }),
      mutant('mutator', 'Survived', { mutatorName: null }),
      mutant('replacement', 'Survived', { replacement: { code: 'false' } }),
    ];

    for (const value of malformed) {
      assert.doesNotThrow(() => classifyMutationReport(report([value])));
      assert.equal(classifyMutationReport(report([value])).classification, 'harness-error');
    }
  });

  it('treats a nonzero runner exit as incomplete even when JSON exists', async () => {
    const { classifyMutationRun } = await import('../mutation-gap-hardener.mjs');
    const result = classifyMutationRun({
      processResult: { exitCode: 1, signal: null, timedOut: false },
      rawReport: report([mutant('killed', 'Killed')]),
    });
    assert.equal(result.classification, 'incomplete');
    assert.equal(mutationRunExitCode(result), 1);
    assert.equal(mutationRunExitCode({ classification: 'report' }), 0);
  });

  it('treats failed process termination as incomplete despite complete JSON', async () => {
    const { classifyMutationRun } = await import('../mutation-gap-hardener.mjs');
    const result = classifyMutationRun({
      processResult: {
        exitCode: 0,
        signal: null,
        terminationFailed: true,
        timedOut: false,
      },
      rawReport: report([mutant('killed', 'Killed')]),
    });

    assert.equal(result.classification, 'incomplete');
    assert.deepEqual(result.reasons, ['Stryker process termination could not be verified']);
    assert.equal(mutationRunExitCode(result), 1);
  });

  it('rejects invalid immutable run identity before launching Stryker', async () => {
    const reportDir = await mkdtemp(path.join(os.tmpdir(), 'mutation-inputs-'));
    let spawnCalls = 0;
    const spawn = async () => {
      spawnCalls += 1;
      return { exitCode: 0, signal: null, timedOut: false };
    };

    try {
      await assert.rejects(
        runMutationGapHardener({ repoRoot: reportDir, reportDir, spawn }),
        /baseSha/u
      );
      await assert.rejects(
        runMutationGapHardener({
          baseSha: 'a'.repeat(40),
          reportDir,
          spawn,
        }),
        /repoRoot/u
      );
      await assert.rejects(
        runMutationGapHardener({ baseSha: 'not-a-sha', repoRoot: reportDir, reportDir, spawn }),
        /baseSha/u
      );
      await assert.rejects(
        runMutationGapHardener({
          baseSha: 'a'.repeat(40),
          repoRoot: 'relative-root',
          reportDir,
          spawn,
        }),
        /repoRoot/u
      );
      assert.equal(spawnCalls, 0);
    } finally {
      await rm(reportDir, { force: true, recursive: true });
    }
  });

  it('sorts deterministically and caps detailed gaps without truncating totals', () => {
    const mutants = Array.from({ length: 30 }, (_, index) =>
      mutant(`mutant-${index}`, 'Survived', {
        location: {
          end: { column: 2, line: 30 - index },
          start: { column: 1, line: 30 - index },
        },
        replacement: String(index),
      })
    );
    const first = classifyMutationReport(report(mutants));
    const second = classifyMutationReport(report([...mutants].reverse()));

    assert.equal(first.totals.survivingMutant, 30);
    assert.equal(first.findings.length, 25);
    assert.equal(first.findings[0].location.start.line, 1);
    assert.deepEqual(first.findings, second.findings);
  });
});
