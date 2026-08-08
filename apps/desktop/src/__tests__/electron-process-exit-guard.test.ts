import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ElectronProcessExitGuard } from '../../e2e/utils/electron-process-exit-guard';

class FakeElectronProcess extends EventEmitter {
  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit('exit', code, signal);
  }
}

describe('ElectronProcessExitGuard', () => {
  it('fails with the exit signal when Electron aborts before teardown', () => {
    const guard = new ElectronProcessExitGuard();
    const process = new FakeElectronProcess();
    guard.observe(process);

    process.exit(null, 'SIGABRT');

    expect(() => guard.assertHealthy()).toThrowError(
      'Electron process exited unexpectedly before intentional close completed (code=null, signal=SIGABRT)'
    );
  });

  it('fails when Electron exits cleanly before intentional teardown begins', () => {
    const guard = new ElectronProcessExitGuard();
    const process = new FakeElectronProcess();
    guard.observe(process);

    process.exit(0, null);

    expect(() => guard.assertHealthy()).toThrowError(
      'Electron process exited unexpectedly before intentional close completed (code=0, signal=none)'
    );
  });

  it('accepts a clean exit after intentional teardown begins', () => {
    const guard = new ElectronProcessExitGuard();
    const process = new FakeElectronProcess();
    guard.observe(process);
    guard.beginIntentionalClose(process);

    process.exit(0, null);

    expect(() => guard.assertHealthy()).not.toThrow();
  });

  it('fails the anti-vacuity floor when no Electron process launched', () => {
    const guard = new ElectronProcessExitGuard();

    expect(() => guard.assertHealthy()).toThrowError(
      'Desktop E2E fixture launched zero Electron processes'
    );
  });
});
