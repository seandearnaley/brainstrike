import { type IpcMainEvent, ipcMain } from 'electron';
import { createDesktopIpcRegistry, type DesktopIpcDomain } from './platform/desktop-ipc-registry';

const UNAUTHENTICATED_SENDER_POLICY = {
  reason:
    'Exposed only by the visible-UI preload (dist/preload.js); sender-role policy pending (BST-1641 follow-up).',
} as const;

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

  registry.registerUnauthenticatedInvoke(
    domain,
    channels.ensureStarted,
    UNAUTHENTICATED_SENDER_POLICY,
    async () => manager.ensureStarted({ waitForRunning: true })
  );
  registry.registerUnauthenticatedInvoke(
    domain,
    channels.stop,
    UNAUTHENTICATED_SENDER_POLICY,
    async () => manager.stop()
  );
  registry.registerUnauthenticatedInvoke(
    domain,
    channels.reset,
    UNAUTHENTICATED_SENDER_POLICY,
    async () => manager.reset()
  );
  registry.registerUnauthenticatedInvoke(
    domain,
    channels.getStatus,
    UNAUTHENTICATED_SENDER_POLICY,
    async () => manager.getStatus()
  );
  const statusReportListener = (event: IpcMainEvent, payload: unknown) => {
    manager.acceptStatusReport(event.sender.id, assertStatus(payload));
  };
  registry.registerEvent(domain, channels.reportStatus, statusReportListener);

  return () => registry.unregisterAll();
}
