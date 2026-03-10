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
          return [];
        default:
          throw new Error(`Unexpected runtime role: ${role}`);
      }
    });
  });

  it('maps tracked renderer windows onto Electron app metrics by runtime role', async () => {
    getAppMetricsMock.mockReturnValue([
      {
        pid: 101,
        cpu: { percentCPUUsage: 14.25, idleWakeupsPerSecond: 3.5 },
        memory: { workingSetSize: 2048, privateBytes: 1024, sharedBytes: 512 },
      },
      {
        pid: 202,
        cpu: { percentCPUUsage: 41.1, idleWakeupsPerSecond: 7.25 },
        memory: { workingSetSize: 4096, privateBytes: 2048, sharedBytes: 1024 },
      },
    ]);

    const { collectBackgroundRuntimeMetrics } = await import('../background-runtime-metrics');

    expect(collectBackgroundRuntimeMetrics()).toEqual([
      {
        runtimeKind: 'visible-ui',
        osProcessId: 101,
        cpuPercent: '14.3',
        idleWakeupsPerSecond: '3.5',
        workingSetKb: '2',
        privateKb: '1',
        sharedKb: '1',
      },
      {
        runtimeKind: 'embedding-host',
        osProcessId: 202,
        cpuPercent: '41.1',
        idleWakeupsPerSecond: '7.3',
        workingSetKb: '4',
        privateKb: '2',
        sharedKb: '1',
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
          return [];
        default:
          throw new Error(`Unexpected runtime role: ${role}`);
      }
    });
    getAppMetricsMock.mockReturnValue([]);

    const { collectBackgroundRuntimeMetrics } = await import('../background-runtime-metrics');

    expect(collectBackgroundRuntimeMetrics()).toEqual([
      {
        runtimeKind: 'visible-ui',
        osProcessId: null,
        unavailableReason: 'missing-os-process-id',
        cpuPercent: null,
        idleWakeupsPerSecond: null,
        workingSetKb: null,
        privateKb: null,
        sharedKb: null,
      },
      {
        runtimeKind: 'embedding-host',
        osProcessId: 303,
        unavailableReason: 'missing-app-metric',
        cpuPercent: null,
        idleWakeupsPerSecond: null,
        workingSetKb: null,
        privateKb: null,
        sharedKb: null,
      },
    ]);
  });
});
