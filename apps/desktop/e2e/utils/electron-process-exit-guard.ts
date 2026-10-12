interface ElectronProcessLike {
  readonly exitCode: number | null;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown;
  readonly signalCode: NodeJS.Signals | null;
}

interface ObservedProcessState {
  intentionalCloseStarted: boolean;
}

function formatUnexpectedExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  intentionalCloseStarted = false
): Error {
  return new Error(
    `Electron process exited unexpectedly ${intentionalCloseStarted ? 'during intentional close' : 'before intentional close began'} (code=${code ?? 'null'}, signal=${signal ?? 'none'})`
  );
}

export class ElectronProcessExitGuard {
  private readonly observedProcesses = new WeakMap<ElectronProcessLike, ObservedProcessState>();
  private launchedProcessCount = 0;
  private unexpectedExit: Error | null = null;

  observe(process: ElectronProcessLike): void {
    if (this.observedProcesses.has(process)) {
      throw new Error('Electron process exit guard cannot observe the same process twice');
    }

    const state: ObservedProcessState = { intentionalCloseStarted: false };
    this.observedProcesses.set(process, state);
    this.launchedProcessCount += 1;
    process.once('exit', (code, signal) => {
      if (this.unexpectedExit) {
        return;
      }
      if (
        state.intentionalCloseStarted &&
        ((code === 0 && signal === null) || signal === 'SIGKILL')
      ) {
        return;
      }
      this.unexpectedExit = formatUnexpectedExit(code, signal, state.intentionalCloseStarted);
    });
  }

  beginIntentionalClose(process: ElectronProcessLike): void {
    const state = this.observedProcesses.get(process);
    if (!state) {
      throw new Error('Electron process exit guard cannot close an unobserved process');
    }
    if (process.exitCode !== null || process.signalCode !== null) {
      this.unexpectedExit ??= formatUnexpectedExit(process.exitCode, process.signalCode);
      return;
    }
    state.intentionalCloseStarted = true;
  }

  assertHealthy(): void {
    if (this.launchedProcessCount === 0) {
      throw new Error('Desktop E2E fixture launched zero Electron processes');
    }
    if (this.unexpectedExit) {
      throw this.unexpectedExit;
    }
  }
}
