import { type IpcMainEvent, ipcMain } from 'electron';

interface BackgroundRuntimeLifecycleManager<TStatus> {
  acceptStatusReport: (senderId: number, report: TStatus) => void;
  ensureStarted: (options?: { waitForRunning?: boolean }) => Promise<TStatus>;
  getStatus: () => Promise<TStatus> | TStatus;
  reset: () => Promise<TStatus> | TStatus;
  stop: () => Promise<TStatus> | TStatus;
}

interface BackgroundRuntimeLifecycleChannels {
  readonly ensureStarted: string;
  readonly getStatus: string;
  readonly reportStatus: string;
  readonly reset: string;
  readonly stop: string;
}

interface RegisterBackgroundRuntimeLifecycleIpcOptions<TStatus> {
  readonly assertStatus: (value: unknown) => TStatus;
  readonly channels: BackgroundRuntimeLifecycleChannels;
  readonly manager: BackgroundRuntimeLifecycleManager<TStatus>;
}

export function registerBackgroundRuntimeLifecycleIpcHandlers<TStatus>(
  options: RegisterBackgroundRuntimeLifecycleIpcOptions<TStatus>
): () => void {
  const { assertStatus, channels, manager } = options;

  ipcMain.handle(channels.ensureStarted, async () =>
    manager.ensureStarted({ waitForRunning: true })
  );
  ipcMain.handle(channels.stop, async () => manager.stop());
  ipcMain.handle(channels.reset, async () => manager.reset());
  ipcMain.handle(channels.getStatus, async () => manager.getStatus());
  ipcMain.on(channels.reportStatus, (event: IpcMainEvent, payload: unknown) => {
    manager.acceptStatusReport(event.sender.id, assertStatus(payload));
  });

  return () => {
    ipcMain.removeHandler(channels.ensureStarted);
    ipcMain.removeHandler(channels.stop);
    ipcMain.removeHandler(channels.reset);
    ipcMain.removeHandler(channels.getStatus);
    ipcMain.removeAllListeners(channels.reportStatus);
  };
}
