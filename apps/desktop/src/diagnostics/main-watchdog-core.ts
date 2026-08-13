export const MAIN_WATCHDOG_CHECK_INTERVAL_MS = 5000;
export const MAIN_WATCHDOG_CHECK_DISCONTINUITY_MS = MAIN_WATCHDOG_CHECK_INTERVAL_MS * 2;
export const MAIN_WATCHDOG_FROZEN_THRESHOLD_MS = 20_000;

export type MainWatchdogMessage =
  | { logPath: string | null; type: 'config' }
  | { type: 'heartbeat' }
  | { type: 'resume' }
  | { type: 'suspend' };

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
  elapsedNow: () => number;
  getCpuUsage: () => CpuUsage;
  getMemoryUsage: () => MemoryUsage;
  wallNow: () => number;
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

function readClock(clock: () => number, name: string): number {
  return readNonNegativeFinite(clock(), name);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createMainWatchdogController(
  dependencies: MainWatchdogDependencies
): MainWatchdogController {
  const initialElapsedNow = readClock(dependencies.elapsedNow, 'elapsed clock value');
  let lastCheckAt = initialElapsedNow;
  let lastHeartbeatAt = initialElapsedNow;
  let previousCpuUsage = readCpuUsage(dependencies.getCpuUsage);
  let hasReceivedConfiguration = false;
  let logPath: string | null = null;
  let suspended = false;

  const resetObservationBaselines = (): void => {
    const currentElapsedNow = readClock(dependencies.elapsedNow, 'elapsed clock value');
    const currentCpuUsage = readCpuUsage(dependencies.getCpuUsage);
    lastCheckAt = currentElapsedNow;
    lastHeartbeatAt = currentElapsedNow;
    previousCpuUsage = currentCpuUsage;
  };

  const handleMessage = (message: unknown): void => {
    if (!(typeof message === 'object' && message !== null && 'type' in message)) {
      throw new Error('Main watchdog received a malformed message');
    }

    if (message.type === 'heartbeat') {
      lastHeartbeatAt = readClock(dependencies.elapsedNow, 'elapsed clock value');
      return;
    }

    if (message.type === 'suspend') {
      suspended = true;
      resetObservationBaselines();
      return;
    }

    if (message.type === 'resume') {
      resetObservationBaselines();
      suspended = false;
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
    const currentElapsedNow = readClock(dependencies.elapsedNow, 'elapsed clock value');
    const elapsedSincePreviousCheck = currentElapsedNow - lastCheckAt;
    readNonNegativeFinite(elapsedSincePreviousCheck, 'check interval');
    lastCheckAt = currentElapsedNow;

    const currentCpuUsage = readCpuUsage(dependencies.getCpuUsage);
    const cpuSystemDeltaMicros = currentCpuUsage.system - previousCpuUsage.system;
    const cpuUserDeltaMicros = currentCpuUsage.user - previousCpuUsage.user;
    previousCpuUsage = currentCpuUsage;

    readNonNegativeFinite(cpuSystemDeltaMicros, 'system CPU delta');
    readNonNegativeFinite(cpuUserDeltaMicros, 'user CPU delta');

    if (suspended) {
      return null;
    }

    const heartbeatAgeMs = currentElapsedNow - lastHeartbeatAt;
    readNonNegativeFinite(heartbeatAgeMs, 'heartbeat age');
    if (elapsedSincePreviousCheck > MAIN_WATCHDOG_CHECK_DISCONTINUITY_MS) {
      lastHeartbeatAt = currentElapsedNow;
      return null;
    }
    if (heartbeatAgeMs <= MAIN_WATCHDOG_FROZEN_THRESHOLD_MS) {
      return null;
    }
    if (!hasReceivedConfiguration) {
      throw new Error('Main watchdog has not received its log path configuration');
    }

    const memoryUsage = dependencies.getMemoryUsage();
    const wallNow = readClock(dependencies.wallNow, 'wall clock value');
    const diagnostic: MainWatchdogDiagnostic = {
      cpuSystemDeltaMicros,
      cpuUserDeltaMicros,
      heapUsedKb: Math.round(readNonNegativeFinite(memoryUsage.heapUsed, 'heap usage') / 1024),
      heartbeatAgeMs,
      level: 50,
      msg: 'MAIN_THREAD_UNRESPONSIVE',
      rssKb: Math.round(readNonNegativeFinite(memoryUsage.rss, 'RSS usage') / 1024),
      scope: 'MainWatchdog',
      time: new Date(wallNow).toISOString(),
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
