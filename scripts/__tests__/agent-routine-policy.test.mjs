import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  freezeRunContext,
  loadFrozenRunContext,
} from '../agent-routines/shared/frozen-run-context.mjs';
import { assertPromotionReady, createPromotionPolicy } from '../agent-routines/shared/policy.mjs';
import { createRoutineResultWriter } from '../agent-routines/shared/routine-result.mjs';

const SHA = 'a'.repeat(40);

describe('scheduled-maintenance frozen run context', () => {
  it('freezes one immutable base SHA and watched set', () => {
    const watchedPaths = ['packages/db'];
    const context = freezeRunContext({
      baseSha: SHA,
      canonicalPath: '/repo',
      watchedPaths,
      worktreePath: '/tmp/routine-worktree',
    });

    watchedPaths.push('packages/agent');

    assert.equal(Object.isFrozen(context), true);
    assert.equal(Object.isFrozen(context.watchedPaths), true);
    assert.deepEqual(context.watchedPaths, ['packages/db']);
    assert.throws(() => {
      context.baseSha = 'b'.repeat(40);
    }, TypeError);
  });

  it('rejects canonical or dirty checkout mutation', async () => {
    await assert.rejects(
      loadFrozenRunContext({
        canonicalPath: '/repo',
        readGitHubState: async () => ({}),
        runGit: async () => ({ stdout: '' }),
        watchedPaths: [],
        worktreePath: '/repo',
      }),
      /isolated worktree/u
    );

    await assert.rejects(
      loadFrozenRunContext({
        canonicalPath: '/repo',
        readGitHubState: async () => ({}),
        runGit: async ({ args }) => ({
          stdout: args[0] === 'rev-parse' ? `${SHA}\n` : ' M package.json\n',
        }),
        watchedPaths: [],
        worktreePath: '/tmp/worktree',
      }),
      /canonical checkout is dirty/u
    );
  });

  it('fails closed when GitHub state cannot be read', async () => {
    await assert.rejects(
      loadFrozenRunContext({
        canonicalPath: '/repo',
        readGitHubState: async () => {
          throw new Error('network unavailable');
        },
        runGit: async ({ args }) => ({ stdout: args[0] === 'rev-parse' ? `${SHA}\n` : '' }),
        watchedPaths: [],
        worktreePath: '/tmp/worktree',
      }),
      /GitHub state is unreadable/u
    );
  });
});

describe('scheduled-maintenance promotion readiness', () => {
  const promotionPolicy = createPromotionPolicy({
    maxDuplicateRate: 0.05,
    maxNoiseRate: 0.1,
    minimumPrecisionByRoutine: {
      'contract-drift': 0.98,
      'model-catalog': 1,
    },
    minimumReports: 10,
    minimumSamples: 20,
  });
  const readySummary = {
    criticalFalsePositives: 0,
    duplicateRate: 0.05,
    noiseRate: 0.1,
    precision: 1,
    reportCount: 10,
    routineId: 'model-catalog',
    sampleCount: 20,
    unsafeFindings: 0,
  };

  it('admits propose-pr only after routine-specific calibration passes', () => {
    assert.doesNotThrow(() => assertPromotionReady(promotionPolicy, readySummary));
    assert.doesNotThrow(() =>
      assertPromotionReady(promotionPolicy, {
        ...readySummary,
        precision: 0.98,
        routineId: 'contract-drift',
      })
    );
  });

  it('fails closed for missing or malformed live calibration data', () => {
    assert.throws(
      () => assertPromotionReady(promotionPolicy, null),
      /calibration data is unreadable/u
    );
    assert.throws(
      () => assertPromotionReady(promotionPolicy, { ...readySummary, duplicateRate: Number.NaN }),
      /calibration data is unreadable/u
    );
    assert.throws(
      () => assertPromotionReady(promotionPolicy, { ...readySummary, routineId: 'unknown' }),
      /no precision threshold/u
    );
  });

  it('blocks inadequate samples, unsafe findings, false positives, duplicates, noise, or precision', () => {
    const blockedSummaries = [
      { ...readySummary, reportCount: 9 },
      { ...readySummary, sampleCount: 19 },
      { ...readySummary, criticalFalsePositives: 1 },
      { ...readySummary, unsafeFindings: 1 },
      { ...readySummary, duplicateRate: 0.051 },
      { ...readySummary, noiseRate: 0.101 },
      { ...readySummary, precision: 0.999 },
    ];
    for (const summary of blockedSummaries) {
      assert.throws(() => assertPromotionReady(promotionPolicy, summary), /not promotion-ready/u);
    }
  });
});

describe('scheduled-maintenance terminal result', () => {
  it('writes exactly one valid terminal RoutineResult', () => {
    const lines = [];
    const writer = createRoutineResultWriter((line) => lines.push(line));

    writer.write({ baseSha: SHA, fingerprint: 'model:a1b2', status: 'no-change' });

    assert.deepEqual(JSON.parse(lines[0]), {
      baseSha: SHA,
      fingerprint: 'model:a1b2',
      status: 'no-change',
    });
    assert.throws(
      () => writer.write({ baseSha: SHA, fingerprint: 'model:a1b2', status: 'no-change' }),
      /already written/u
    );
  });

  it('rejects incomplete terminal results and a run with no result', () => {
    const writer = createRoutineResultWriter(() => {});
    assert.throws(() => writer.write({ status: 'blocked' }), /invalid RoutineResult/u);
    assert.throws(() => writer.assertWritten(), /was not written/u);
  });
});
