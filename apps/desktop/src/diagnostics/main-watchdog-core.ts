export const MAIN_WATCHDOG_CHECK_INTERVAL_MS = 5000;
export const MAIN_WATCHDOG_FROZEN_THRESHOLD_MS = 20_000;

export type MainWatchdogMessage =
  | { logPath: string | null; type: 'config' }
  | { type: 'heartbeat' };

interface CpuUsage {
  system: number;
  user: number;
}

interface MemoryUsage {
  heapUsed: number;
  rss: number;
}

export interface MainWatchdogDiagnostic {
  cpuSystemDeltaMicros: number;
  cpuUserDeltaMicros: number;
  heapUsedKb: number;
  heartbeatAgeMs: number;
  level: 50;
  msg: 'MAIN_THREAD_UNRESPONSIVE';
  rssKb: number;
  scope: 'MainWatchdog';
  time: string;
}

interface MainWatchdogDependencies {
  appendFile: (logPath: string, record: string) => void;
  getCpuUsage: () => CpuUsage;
  getMemoryUsage: () => MemoryUsage;
  now: () => number;
  writeStderr: (record: string) => void;
}

export interface MainWatchdogController {
  check: () => MainWatchdogDiagnostic | null;
  handleMessage: (message: unknown) => void;
}

function readNonNegativeFinite(value: number, name: string): number {
  if (!(Number.isFinite(value) && value >= 0)) {
    throw new Error(`Main watchdog ${name} must be a non-negative finite number`);
  }
  return value;
}

function readCpuUsage(getCpuUsage: () => CpuUsage): CpuUsage {
  const usage = getCpuUsage();
  return {
    system: readNonNegativeFinite(usage.system, 'system CPU usage'),
    user: readNonNegativeFinite(usage.user, 'user CPU usage'),
  };
}

function readNow(now: () => number): number {
  return readNonNegativeFinite(now(), 'clock value');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createMainWatchdogController(
  dependencies: MainWatchdogDependencies
): MainWatchdogController {
  let lastHeartbeatAt = readNow(dependencies.now);
  let previousCpuUsage = readCpuUsage(dependencies.getCpuUsage);
  let hasReceivedConfiguration = false;
  let logPath: string | null = null;

  const handleMessage = (message: unknown): void => {
    if (!(typeof message === 'object' && message !== null && 'type' in message)) {
      throw new Error('Main watchdog received a malformed message');
    }

    if (message.type === 'heartbeat') {
      lastHeartbeatAt = readNow(dependencies.now);
      return;
    }

    if (message.type !== 'config' || !('logPath' in message)) {
      throw new Error('Main watchdog received an unsupported message type');
    }
    if (!(message.logPath === null || typeof message.logPath === 'string')) {
      throw new Error('Main watchdog log path must be a string or null');
    }
    if (message.logPath !== null && message.logPath.length === 0) {
      throw new Error('Main watchdog log path must not be empty');
    }

    logPath = message.logPath;
    hasReceivedConfiguration = true;
  };

  const check = (): MainWatchdogDiagnostic | null => {
    const currentTime = readNow(dependencies.now);
    const currentCpuUsage = readCpuUsage(dependencies.getCpuUsage);
    const cpuSystemDeltaMicros = currentCpuUsage.system - previousCpuUsage.system;
    const cpuUserDeltaMicros = currentCpuUsage.user - previousCpuUsage.user;
    previousCpuUsage = currentCpuUsage;

    readNonNegativeFinite(cpuSystemDeltaMicros, 'system CPU delta');
    readNonNegativeFinite(cpuUserDeltaMicros, 'user CPU delta');

    const heartbeatAgeMs = currentTime - lastHeartbeatAt;
    readNonNegativeFinite(heartbeatAgeMs, 'heartbeat age');
    if (heartbeatAgeMs <= MAIN_WATCHDOG_FROZEN_THRESHOLD_MS) {
      return null;
    }
    if (!hasReceivedConfiguration) {
      throw new Error('Main watchdog has not received its log path configuration');
    }

    const memoryUsage = dependencies.getMemoryUsage();
    const diagnostic: MainWatchdogDiagnostic = {
      cpuSystemDeltaMicros,
      cpuUserDeltaMicros,
      heapUsedKb: Math.round(readNonNegativeFinite(memoryUsage.heapUsed, 'heap usage') / 1024),
      heartbeatAgeMs,
      level: 50,
      msg: 'MAIN_THREAD_UNRESPONSIVE',
      rssKb: Math.round(readNonNegativeFinite(memoryUsage.rss, 'RSS usage') / 1024),
      scope: 'MainWatchdog',
      time: new Date(currentTime).toISOString(),
    };
    const serializedDiagnostic = `${JSON.stringify(diagnostic)}\n`;
    dependencies.writeStderr(serializedDiagnostic);

    if (logPath === null) {
      return diagnostic;
    }

    try {
      dependencies.appendFile(logPath, serializedDiagnostic);
    } catch (error) {
      dependencies.writeStderr(
        `${JSON.stringify({
          error: errorMessage(error),
          level: 50,
          msg: 'MAIN_WATCHDOG_LOG_WRITE_FAILED',
          scope: 'MainWatchdog',
          time: diagnostic.time,
        })}\n`
      );
    }
    return diagnostic;
  };

  return { check, handleMessage };
}
