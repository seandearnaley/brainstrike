import { type IpcMainEvent, ipcMain } from 'electron';
import { createDesktopIpcRegistry, type DesktopIpcDomain } from './platform/desktop-ipc-registry';

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
  readonly domain: DesktopIpcDomain;
  readonly manager: BackgroundRuntimeLifecycleManager<TStatus>;
}

export function registerBackgroundRuntimeLifecycleIpcHandlers<TStatus>(
  options: RegisterBackgroundRuntimeLifecycleIpcOptions<TStatus>
): () => void {
  const { assertStatus, channels, domain, manager } = options;
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerInvoke(domain, channels.ensureStarted, async () =>
    manager.ensureStarted({ waitForRunning: true })
  );
  registry.registerInvoke(domain, channels.stop, async () => manager.stop());
  registry.registerInvoke(domain, channels.reset, async () => manager.reset());
  registry.registerInvoke(domain, channels.getStatus, async () => manager.getStatus());
  const statusReportListener = (event: IpcMainEvent, payload: unknown) => {
    manager.acceptStatusReport(event.sender.id, assertStatus(payload));
  };
  registry.registerEvent(domain, channels.reportStatus, statusReportListener);

  return () => registry.unregisterAll();
}
