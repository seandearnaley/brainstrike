export type DesktopResetDiagnosticsStatus = 'completed' | 'failed' | 'idle' | 'running';

export interface DesktopResetDiagnosticsSnapshot {
  readonly lastCompletedAt: string | null;
  readonly lastDeletedPathCount: number;
  readonly lastError: string | null;
  readonly lastFailedAt: string | null;
  readonly lastPreservedPathCount: number;
  readonly lastStartedAt: string | null;
  readonly status: DesktopResetDiagnosticsStatus;
  readonly userDataPath: string;
}

interface ResetCompletedEvent {
  readonly deletedPathCount: number;
  readonly preservedPathCount: number;
  readonly userDataPath: string;
}

interface ResetFailedEvent {
  readonly error: unknown;
  readonly userDataPath: string;
}

let snapshot: Omit<DesktopResetDiagnosticsSnapshot, 'userDataPath'> = {
  lastCompletedAt: null,
  lastDeletedPathCount: 0,
  lastError: null,
  lastFailedAt: null,
  lastPreservedPathCount: 0,
  lastStartedAt: null,
  status: 'idle',
};

function nowIsoString(): string {
  return new Date().toISOString();
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function recordDesktopResetStarted(): void {
  Object.assign(snapshot, {
    lastError: null,
    lastStartedAt: nowIsoString(),
    status: 'running',
  });
}

export function recordDesktopResetCompleted({
  deletedPathCount,
  preservedPathCount,
}: ResetCompletedEvent): void {
  Object.assign(snapshot, {
    lastCompletedAt: nowIsoString(),
    lastDeletedPathCount: deletedPathCount,
    lastError: null,
    lastPreservedPathCount: preservedPathCount,
    status: 'completed',
  });
}

export function recordDesktopResetFailed({ error }: ResetFailedEvent): void {
  Object.assign(snapshot, {
    lastError: getErrorMessage(error),
    lastFailedAt: nowIsoString(),
    status: 'failed',
  });
}

export function getDesktopResetDiagnosticsSnapshot(
  userDataPath: string
): DesktopResetDiagnosticsSnapshot {
  return {
    ...snapshot,
    userDataPath,
  };
}

export function resetDesktopResetDiagnosticsForTests(): void {
  snapshot = {
    lastCompletedAt: null,
    lastDeletedPathCount: 0,
    lastError: null,
    lastFailedAt: null,
    lastPreservedPathCount: 0,
    lastStartedAt: null,
    status: 'idle',
  };
}
