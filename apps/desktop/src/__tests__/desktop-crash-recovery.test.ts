import { beforeEach, describe, expect, it } from 'vitest';
import {
  getDesktopCrashRecoverySnapshot,
  recordRendererCrashDeferred,
  recordRendererCrashLoopSuppressed,
  recordRendererRecoveryReloadAttempt,
  resetDesktopCrashRecoveryDiagnosticsForTests,
} from '../desktop-crash-recovery';

describe('desktop crash recovery diagnostics', () => {
  beforeEach(() => {
    resetDesktopCrashRecoveryDiagnosticsForTests();
  });

  it('tracks deferred renderer crash recovery without hiding pending reload state', () => {
    recordRendererCrashDeferred({
      crashCountInWindow: 1,
      exitCode: 5,
      reason: 'crashed',
      windowRole: 'visible-ui',
    });

    expect(getDesktopCrashRecoverySnapshot()).toMatchObject({
      lastRendererCrashReason: 'crashed',
      pendingRendererRecovery: true,
      rendererCrashCount: 1,
      rendererReloadAttemptCount: 0,
      suppressedRendererReloadCount: 0,
    });

    recordRendererRecoveryReloadAttempt({ windowRole: 'visible-ui' });

    expect(getDesktopCrashRecoverySnapshot()).toMatchObject({
      pendingRendererRecovery: false,
      rendererReloadAttemptCount: 1,
    });
  });

  it('tracks suppressed reloads when crash-loop protection refuses recovery', () => {
    recordRendererCrashLoopSuppressed({
      crashCountInWindow: 4,
      exitCode: 5,
      reason: 'crashed',
      windowRole: 'visible-ui',
    });

    expect(getDesktopCrashRecoverySnapshot()).toMatchObject({
      lastRendererCrashReason: 'crashed',
      pendingRendererRecovery: false,
      rendererCrashCount: 1,
      suppressedRendererReloadCount: 1,
    });
  });
});
