export interface DesktopRendererCrashRecoverySnapshot {
  readonly lastRendererCrashAt: string | null;
  readonly lastRendererCrashExitCode: number | null;
  readonly lastRendererCrashReason: string | null;
  readonly lastRendererCrashWindowRole: string | null;
  readonly lastRendererReloadAt: string | null;
  readonly lastRendererReloadWindowRole: string | null;
  readonly pendingRendererRecovery: boolean;
  readonly rendererCrashCount: number;
  readonly rendererReloadAttemptCount: number;
  readonly suppressedRendererReloadCount: number;
}

interface RendererCrashRecoveryEvent {
  readonly crashCountInWindow: number;
  readonly exitCode: number;
  readonly reason: string;
  readonly windowRole: string;
}

interface RendererReloadRecoveryEvent {
  readonly windowRole: string;
}

const INITIAL_SNAPSHOT: DesktopRendererCrashRecoverySnapshot = {
  lastRendererCrashAt: null,
  lastRendererCrashExitCode: null,
  lastRendererCrashReason: null,
  lastRendererCrashWindowRole: null,
  lastRendererReloadAt: null,
  lastRendererReloadWindowRole: null,
  pendingRendererRecovery: false,
  rendererCrashCount: 0,
  rendererReloadAttemptCount: 0,
  suppressedRendererReloadCount: 0,
};

let snapshot: DesktopRendererCrashRecoverySnapshot = INITIAL_SNAPSHOT;

function nowIsoString(): string {
  return new Date().toISOString();
}

function recordRendererCrash(event: RendererCrashRecoveryEvent): void {
  snapshot = {
    ...snapshot,
    lastRendererCrashAt: nowIsoString(),
    lastRendererCrashExitCode: event.exitCode,
    lastRendererCrashReason: event.reason,
    lastRendererCrashWindowRole: event.windowRole,
    rendererCrashCount: snapshot.rendererCrashCount + 1,
  };
}

export function recordRendererCrashDeferred(event: RendererCrashRecoveryEvent): void {
  recordRendererCrash(event);
  snapshot = {
    ...snapshot,
    pendingRendererRecovery: true,
  };
}

export function recordRendererCrashLoopSuppressed(event: RendererCrashRecoveryEvent): void {
  recordRendererCrash(event);
  snapshot = {
    ...snapshot,
    pendingRendererRecovery: false,
    suppressedRendererReloadCount: snapshot.suppressedRendererReloadCount + 1,
  };
}

export function recordRendererRecoveryReloadAttempt(event: RendererReloadRecoveryEvent): void {
  snapshot = {
    ...snapshot,
    lastRendererReloadAt: nowIsoString(),
    lastRendererReloadWindowRole: event.windowRole,
    pendingRendererRecovery: false,
    rendererReloadAttemptCount: snapshot.rendererReloadAttemptCount + 1,
  };
}

export function getDesktopCrashRecoverySnapshot(): DesktopRendererCrashRecoverySnapshot {
  return snapshot;
}

export function resetDesktopCrashRecoveryDiagnosticsForTests(): void {
  snapshot = INITIAL_SNAPSHOT;
}
