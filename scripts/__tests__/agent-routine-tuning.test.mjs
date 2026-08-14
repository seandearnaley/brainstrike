import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { tightenRoutineTuning } from '../agent-routines/shared/tuning.mjs';

const current = Object.freeze({
  confidenceFloor: 0.8,
  dedupeWindowRuns: 2,
  maxFindings: 50,
  recentWindowHours: 96,
  revision: 3,
});
const evaluation = Object.freeze({
  criticalFalsePositives: 0,
  duplicateRate: 0.2,
  noiseRate: 0.25,
  precision: 0.7,
  reportCount: 10,
  routineId: 'model-catalog-updater',
  sampleCount: 20,
  unsafeFindings: 0,
});
const targets = Object.freeze({ maxDuplicateRate: 0.1, maxNoiseRate: 0.1 });

describe('bounded automatic routine tuning', () => {
  it('deterministically tightens noisy and duplicate-heavy reports', () => {
    const first = tightenRoutineTuning({ current, evaluation, targets });
    const second = tightenRoutineTuning({ current, evaluation, targets });
    assert.deepEqual(first, second);
    assert.deepEqual(first.next, {
      confidenceFloor: 0.82,
      dedupeWindowRuns: 3,
      maxFindings: 40,
      recentWindowHours: 72,
      revision: 4,
    });
    assert.deepEqual(
      first.changes.map(({ field }) => field),
      ['confidenceFloor', 'dedupeWindowRuns', 'maxFindings', 'recentWindowHours']
    );
    assert.equal(first.requiresManualIntervention, false);
  });

  it('does not oscillate or invent a change when evaluation is within bounds', () => {
    const result = tightenRoutineTuning({
      current,
      evaluation: { ...evaluation, duplicateRate: 0, noiseRate: 0, precision: 1 },
      targets,
    });
    assert.deepEqual(result.next, current);
    assert.deepEqual(result.changes, []);
    assert.equal(result.requiresManualIntervention, false);
  });

  it('fails closed on unmodelled keys that could widen authority', () => {
    for (const unsafeCurrent of [
      { ...current, allowedFiles: ['**'] },
      { ...current, evidenceRequired: false },
      { ...current, permissions: 'write-all' },
    ]) {
      assert.throws(
        () => tightenRoutineTuning({ current: unsafeCurrent, evaluation, targets }),
        /unmodelled tuning key/u
      );
    }
  });

  it('stops at hard bounds and requests manual intervention for unsafe findings', () => {
    const result = tightenRoutineTuning({
      current: {
        confidenceFloor: 0.99,
        dedupeWindowRuns: 20,
        maxFindings: 1,
        recentWindowHours: 24,
        revision: 7,
      },
      evaluation: {
        ...evaluation,
        criticalFalsePositives: 1,
        duplicateRate: 1,
        noiseRate: 1,
        unsafeFindings: 1,
      },
      targets,
    });
    assert.equal(result.next.revision, 7);
    assert.deepEqual(result.changes, []);
    assert.equal(result.requiresManualIntervention, true);
  });
});
