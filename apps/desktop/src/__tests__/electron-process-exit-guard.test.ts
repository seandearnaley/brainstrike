import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ElectronProcessExitGuard } from '../../e2e/utils/electron-process-exit-guard';

class FakeElectronProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }

  recordExitWithoutEmitting(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
  }
}

describe('ElectronProcessExitGuard', () => {
  it('fails with the exit signal when Electron aborts before teardown', () => {
    const guard = new ElectronProcessExitGuard();
    const process = new FakeElectronProcess();
    guard.observe(process);

    process.exit(null, 'SIGABRT');

    expect(() => guard.assertHealthy()).toThrowError(
      'Electron process exited unexpectedly before intentional close began (code=null, signal=SIGABRT)'
    );
  });

  it('fails when Electron exits cleanly before intentional teardown begins', () => {
    const guard = new ElectronProcessExitGuard();
    const process = new FakeElectronProcess();
    guard.observe(process);

    process.exit(0, null);

    expect(() => guard.assertHealthy()).toThrowError(
      'Electron process exited unexpectedly before intentional close began (code=0, signal=none)'
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

  it('fails when Electron aborts during intentional teardown', () => {
    const guard = new ElectronProcessExitGuard();
    const process = new FakeElectronProcess();
    guard.observe(process);
    guard.beginIntentionalClose(process);

    process.exit(null, 'SIGABRT');

    expect(() => guard.assertHealthy()).toThrowError(
      'Electron process exited unexpectedly during intentional close (code=null, signal=SIGABRT)'
    );
  });

  it.each([
    [1, null],
    [null, 'SIGSEGV'],
  ] as const)('rejects abnormal teardown exit %s/%s', (code, signal) => {
    const guard = new ElectronProcessExitGuard();
    const process = new FakeElectronProcess();
    guard.observe(process);
    guard.beginIntentionalClose(process);
    process.exit(code, signal);
    expect(() => guard.assertHealthy()).toThrow('during intentional close');
  });

  it('rejects a forced exit after intentional teardown begins', () => {
    const guard = new ElectronProcessExitGuard();
    const process = new FakeElectronProcess();
    guard.observe(process);
    guard.beginIntentionalClose(process);

    process.exit(null, 'SIGKILL');

    expect(() => guard.assertHealthy()).toThrow('SIGKILL');
  });

  it('fails when the process exited before teardown but its exit event is still pending', () => {
    const guard = new ElectronProcessExitGuard();
    const process = new FakeElectronProcess();
    guard.observe(process);
    process.recordExitWithoutEmitting(null, 'SIGABRT');

    guard.beginIntentionalClose(process);

    expect(() => guard.assertHealthy()).toThrowError(
      'Electron process exited unexpectedly before intentional close began (code=null, signal=SIGABRT)'
    );
  });

  it('fails the anti-vacuity floor when no Electron process launched', () => {
    const guard = new ElectronProcessExitGuard();

    expect(() => guard.assertHealthy()).toThrowError(
      'Desktop E2E fixture launched zero Electron processes'
    );
  });
});
