import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAppMetricsMock = vi.fn();
const getTrackedWindowsByRoleMock = vi.fn();

vi.mock('electron', () => ({
  app: {
    getAppMetrics: getAppMetricsMock,
  },
}));

vi.mock('../window-role', () => ({
  getTrackedWindowsByRole: getTrackedWindowsByRoleMock,
}));

describe('collectBackgroundRuntimeMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTrackedWindowsByRoleMock.mockImplementation((role: string) => {
      switch (role) {
        case 'visible-ui':
          return [
            {
              webContents: {
                getOSProcessId: () => 101,
              },
            },
          ];
        case 'embedding-host':
          return [
            {
              webContents: {
                getOSProcessId: () => 202,
              },
            },
          ];
        case 'chunking-host':
        case 'llm-host':
          return [];
        default:
          throw new Error(`Unexpected runtime role: ${role}`);
      }
    });
  });

  it('maps tracked renderer windows onto Electron app metrics by runtime role', async () => {
    getAppMetricsMock.mockReturnValue([
      {
        cpu: { idleWakeupsPerSecond: 3.5, percentCPUUsage: 14.25 },
        memory: { privateBytes: 1024, sharedBytes: 512, workingSetSize: 2048 },
        pid: 101,
      },
      {
        cpu: { idleWakeupsPerSecond: 7.25, percentCPUUsage: 41.1 },
        memory: { privateBytes: 2048, sharedBytes: 1024, workingSetSize: 4096 },
        pid: 202,
      },
    ]);

    const { collectBackgroundRuntimeMetrics } = await import('../background-runtime-metrics');

    expect(collectBackgroundRuntimeMetrics()).toEqual([
      {
        cpuPercent: '14.3',
        idleWakeupsPerSecond: '3.5',
        osProcessId: 101,
        privateKb: '1024',
        runtimeKind: 'visible-ui',
        sharedKb: '512',
        workingSetKb: '2048',
      },
      {
        cpuPercent: '41.1',
        idleWakeupsPerSecond: '7.3',
        osProcessId: 202,
        privateKb: '2048',
        runtimeKind: 'embedding-host',
        sharedKb: '1024',
        workingSetKb: '4096',
      },
    ]);
  });

  it('reports explicit unavailable reasons when window process metrics cannot be resolved', async () => {
    getTrackedWindowsByRoleMock.mockImplementation((role: string) => {
      switch (role) {
        case 'visible-ui':
          return [
            {
              webContents: {
                getOSProcessId: () => 0,
              },
            },
          ];
        case 'embedding-host':
          return [
            {
              webContents: {
                getOSProcessId: () => 303,
              },
            },
          ];
        case 'chunking-host':
        case 'llm-host':
          return [];
        default:
          throw new Error(`Unexpected runtime role: ${role}`);
      }
    });
    getAppMetricsMock.mockReturnValue([]);

    const { collectBackgroundRuntimeMetrics } = await import('../background-runtime-metrics');

    expect(collectBackgroundRuntimeMetrics()).toEqual([
      {
        cpuPercent: null,
        idleWakeupsPerSecond: null,
        osProcessId: null,
        privateKb: null,
        runtimeKind: 'visible-ui',
        sharedKb: null,
        unavailableReason: 'missing-os-process-id',
        workingSetKb: null,
      },
      {
        cpuPercent: null,
        idleWakeupsPerSecond: null,
        osProcessId: 303,
        privateKb: null,
        runtimeKind: 'embedding-host',
        sharedKb: null,
        unavailableReason: 'missing-app-metric',
        workingSetKb: null,
      },
    ]);
  });
});
