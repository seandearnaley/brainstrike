import { describe, expect, it } from 'vitest';
import {
  resolveWorkspaceIndexingQosPolicy,
  type WorkspaceIndexingQosInputs,
} from '../indexing-qos-controller';

const baseInputs: WorkspaceIndexingQosInputs = {
  dbPressure: {
    available: true,
    foregroundPressure: false,
    normalPressure: false,
  },
  foregroundQueryActive: false,
  idleState: 'active',
  idleTimeMs: 0,
  manualPaused: false,
  powerSource: 'ac',
  providerRateLimited: false,
  queueDepth: 0,
  recentUserInputMs: null,
  thermalState: 'nominal',
  windowVisible: true,
};

function resolve(overrides: Partial<WorkspaceIndexingQosInputs> = {}) {
  return resolveWorkspaceIndexingQosPolicy({
    ...baseInputs,
    ...overrides,
  });
}

describe('resolveWorkspaceIndexingQosPolicy', () => {
  it('returns zero new-work capacity while manually paused', () => {
    const policy = resolve({ manualPaused: true });

    expect(policy).toMatchObject({
      allowNewWork: false,
      allowPowerSaveBlocker: false,
      contentReadBatchSize: 0,
      contentReadConcurrency: 0,
      importBatchSize: 0,
      interBatchDelayMs: 1000,
      reason: 'manual-paused',
      scanBatchSize: 0,
      state: 'paused',
      workerClaimBatchSize: 0,
    });
  });

  it('blocks new background claims while a foreground query is active', () => {
    const policy = resolve({ foregroundQueryActive: true, queueDepth: 120 });

    expect(policy).toMatchObject({
      allowNewWork: false,
      allowPowerSaveBlocker: false,
      reason: 'foreground-query',
      state: 'foreground-yielding',
      workerClaimBatchSize: 0,
    });
  });

  it('constrains work after recent user activity', () => {
    const policy = resolve({ recentUserInputMs: 1200, queueDepth: 80 });

    expect(policy.state).toBe('interactive');
    expect(policy.contentReadConcurrency).toBe(1);
    expect(policy.workerClaimBatchSize).toBe(1);
    expect(policy.importBatchSize).toBeLessThan(baseInputs.queueDepth + 24);
  });

  it('raises throughput only when idle on AC power without DB pressure', () => {
    const policy = resolve({
      idleState: 'idle',
      idleTimeMs: 90_000,
      queueDepth: 500,
      windowVisible: false,
    });

    expect(policy).toMatchObject({
      allowNewWork: true,
      allowPowerSaveBlocker: true,
      contentReadConcurrency: 4,
      importBatchSize: 48,
      reason: 'idle-ac',
      state: 'idle-ac',
      workerClaimBatchSize: 16,
    });
  });

  it('uses constrained policy on battery or serious thermal pressure', () => {
    expect(resolve({ powerSource: 'battery' })).toMatchObject({
      allowPowerSaveBlocker: false,
      contentReadConcurrency: 1,
      reason: 'battery',
      state: 'system-constrained',
      workerClaimBatchSize: 1,
    });

    expect(resolve({ thermalState: 'serious' })).toMatchObject({
      allowPowerSaveBlocker: false,
      reason: 'thermal-serious',
      state: 'system-constrained',
      workerClaimBatchSize: 1,
    });
  });

  it('yields to foreground database pressure', () => {
    const policy = resolve({
      dbPressure: {
        available: true,
        foregroundPressure: true,
        normalPressure: false,
      },
      queueDepth: 50,
    });

    expect(policy).toMatchObject({
      reason: 'foreground-db-pressure',
      state: 'foreground-yielding',
      workerClaimBatchSize: 0,
    });
  });

  it('throws when the required DB pressure snapshot is missing', () => {
    expect(() =>
      resolve({
        dbPressure: {
          available: false,
        },
      })
    ).toThrow('Workspace Index QoS requires a database pressure snapshot.');
  });

  it('preserves the existing balanced worker claim throughput', () => {
    const policy = resolve({ windowVisible: false });

    expect(policy).toMatchObject({
      state: 'balanced',
      workerClaimBatchSize: 16,
    });
  });
});
