export interface DesktopRendererCrashRecoverySnapshot {
  readonly lastRendererCrashAt: string | null;
  readonly lastRendererCrashExitCode: number | null;
  readonly lastRendererCrashReason: string | null;
  readonly lastRendererReloadAt: string | null;
  readonly pendingRendererRecovery: boolean;
  readonly rendererCrashCount: number;
  readonly rendererReloadAttemptCount: number;
  readonly suppressedRendererReloadCount: number;
}

interface RendererCrashRecoveryEvent {
  readonly crashCountInWindow: number;
  readonly exitCode: number;
  readonly reason: string;
}

const INITIAL_SNAPSHOT: DesktopRendererCrashRecoverySnapshot = {
  lastRendererCrashAt: null,
  lastRendererCrashExitCode: null,
  lastRendererCrashReason: null,
  lastRendererReloadAt: null,
  pendingRendererRecovery: false,
  rendererCrashCount: 0,
  rendererReloadAttemptCount: 0,
  suppressedRendererReloadCount: 0,
};

let snapshot: DesktopRendererCrashRecoverySnapshot = { ...INITIAL_SNAPSHOT };

function nowIsoString(): string {
  return new Date().toISOString();
}

function recordRendererCrash(event: RendererCrashRecoveryEvent): void {
  Object.assign(snapshot, {
    lastRendererCrashAt: nowIsoString(),
    lastRendererCrashExitCode: event.exitCode,
    lastRendererCrashReason: event.reason,
    rendererCrashCount: snapshot.rendererCrashCount + 1,
  });
}

export function recordRendererCrashDeferred(event: RendererCrashRecoveryEvent): void {
  recordRendererCrash(event);
  Object.assign(snapshot, {
    pendingRendererRecovery: true,
  });
}

export function recordRendererCrashLoopSuppressed(event: RendererCrashRecoveryEvent): void {
  recordRendererCrash(event);
  Object.assign(snapshot, {
    pendingRendererRecovery: false,
    suppressedRendererReloadCount: snapshot.suppressedRendererReloadCount + 1,
  });
}

export function recordRendererRecoveryReloadAttempt(): void {
  Object.assign(snapshot, {
    lastRendererReloadAt: nowIsoString(),
    pendingRendererRecovery: false,
    rendererReloadAttemptCount: snapshot.rendererReloadAttemptCount + 1,
  });
}

export function getDesktopCrashRecoverySnapshot(): DesktopRendererCrashRecoverySnapshot {
  return snapshot;
}

/** @internal Isolates crash-recovery diagnostics regressions. */
export function resetDesktopCrashRecoveryDiagnosticsForTests(): void {
  snapshot = { ...INITIAL_SNAPSHOT };
}
