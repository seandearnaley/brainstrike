import { app } from 'electron';
import { type DesktopWindowRole, getTrackedWindowsByRole } from './window-role';

export interface BackgroundRuntimeProcessMetric {
  readonly cpuPercent: string | null;
  readonly idleWakeupsPerSecond: string | null;
  readonly osProcessId: number | null;
  readonly privateKb: string | null;
  readonly runtimeKind: DesktopWindowRole;
  readonly sharedKb: string | null;
  readonly unavailableReason?: 'missing-app-metric' | 'missing-os-process-id';
  readonly workingSetKb: string | null;
}

type ElectronProcessMetric = ReturnType<typeof app.getAppMetrics>[number];
type ElectronProcessMemoryInfo = ElectronProcessMetric['memory'] & {
  readonly sharedBytes?: number;
};

function formatMetricValue(value: number | undefined): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : null;
}

function formatKilobytes(value: number | undefined): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(0) : null;
}

function createUnavailableMetric(
  runtimeKind: DesktopWindowRole,
  unavailableReason: 'missing-app-metric' | 'missing-os-process-id',
  osProcessId: number | null
): BackgroundRuntimeProcessMetric {
  return {
    cpuPercent: null,
    idleWakeupsPerSecond: null,
    osProcessId,
    privateKb: null,
    runtimeKind,
    sharedKb: null,
    unavailableReason,
    workingSetKb: null,
  };
}

function createMetricFromProcessMetric(
  runtimeKind: DesktopWindowRole,
  osProcessId: number,
  metric: ElectronProcessMetric
): BackgroundRuntimeProcessMetric {
  const memory = metric.memory as ElectronProcessMemoryInfo;
  return {
    cpuPercent: formatMetricValue(metric.cpu.percentCPUUsage),
    idleWakeupsPerSecond: formatMetricValue(metric.cpu.idleWakeupsPerSecond),
    osProcessId,
    privateKb: formatKilobytes(memory.privateBytes),
    runtimeKind,
    sharedKb: formatKilobytes(memory.sharedBytes),
    workingSetKb: formatKilobytes(memory.workingSetSize),
  };
}

export function collectBackgroundRuntimeMetrics(): BackgroundRuntimeProcessMetric[] {
  const metricsByPid = new Map<number, ElectronProcessMetric>();
  for (const metric of app.getAppMetrics()) {
    metricsByPid.set(metric.pid, metric);
  }

  const runtimeKinds: DesktopWindowRole[] = ['visible-ui', 'embedding-host', 'chunking-host'];
  const runtimeMetrics: BackgroundRuntimeProcessMetric[] = [];

  for (const runtimeKind of runtimeKinds) {
    for (const window of getTrackedWindowsByRole(runtimeKind)) {
      const osProcessId = window.webContents.getOSProcessId();
      if (!Number.isInteger(osProcessId) || osProcessId <= 0) {
        runtimeMetrics.push(createUnavailableMetric(runtimeKind, 'missing-os-process-id', null));
        continue;
      }
      const metric = metricsByPid.get(osProcessId);
      if (!metric) {
        runtimeMetrics.push(
          createUnavailableMetric(runtimeKind, 'missing-app-metric', osProcessId)
        );
        continue;
      }
      runtimeMetrics.push(createMetricFromProcessMetric(runtimeKind, osProcessId, metric));
    }
  }

  return runtimeMetrics;
}
