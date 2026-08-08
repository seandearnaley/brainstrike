interface ElectronProcessLike {
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown;
}

interface ObservedProcessState {
  intentionalCloseStarted: boolean;
}

function formatUnexpectedExit(code: number | null, signal: NodeJS.Signals | null): Error {
  return new Error(
    `Electron process exited unexpectedly before intentional close completed (code=${code ?? 'null'}, signal=${signal ?? 'none'})`
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
      const exitedCleanlyDuringIntentionalClose =
        state.intentionalCloseStarted && code === 0 && signal === null;
      if (exitedCleanlyDuringIntentionalClose || this.unexpectedExit) {
        return;
      }
      this.unexpectedExit = formatUnexpectedExit(code, signal);
    });
  }

  beginIntentionalClose(process: ElectronProcessLike): void {
    const state = this.observedProcesses.get(process);
    if (!state) {
      throw new Error('Electron process exit guard cannot close an unobserved process');
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
