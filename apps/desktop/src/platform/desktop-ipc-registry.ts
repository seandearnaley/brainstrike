import type { ipcMain as ElectronIpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';

export type DesktopIpcDomain =
  | 'agent'
  | 'chunking-host'
  | 'db'
  | 'diagnostics'
  | 'embeddings'
  | 'files'
  | 'llm-host'
  | 'logging'
  | 'mcp'
  | 'preferences'
  | 'runtime'
  | 'storage'
  | 'tools';

export type DesktopIpcChannelKind = 'event' | 'invoke';

export interface DesktopIpcChannelRegistration {
  readonly channel: string;
  readonly domain: DesktopIpcDomain;
  readonly kind: DesktopIpcChannelKind;
}

export type DesktopIpcInvokeHandler<
  Args extends readonly unknown[] = readonly unknown[],
  Result = unknown,
> = (event: IpcMainInvokeEvent, ...args: Args) => Promise<Result> | Result;

export type DesktopIpcEventHandler<Payload = unknown> = (
  event: IpcMainEvent,
  payload: Payload
) => void;

interface DesktopIpcMainLike {
  readonly handle: typeof ElectronIpcMain.handle;
  readonly on: typeof ElectronIpcMain.on;
  readonly removeHandler: typeof ElectronIpcMain.removeHandler;
  readonly removeListener: typeof ElectronIpcMain.removeListener;
}

interface DesktopIpcRegistryOptions {
  readonly ipcMain: DesktopIpcMainLike;
}

interface RegisteredInvokeChannel extends DesktopIpcChannelRegistration {
  readonly kind: 'invoke';
}

interface RegisteredEventChannel extends DesktopIpcChannelRegistration {
  readonly handler: DesktopIpcEventHandler;
  readonly kind: 'event';
}

type RegisteredChannel = RegisteredEventChannel | RegisteredInvokeChannel;

export interface DesktopIpcRegistry {
  readonly getSnapshot: () => DesktopIpcChannelRegistration[];
  readonly registerEvent: <Payload>(
    domain: DesktopIpcDomain,
    channel: string,
    handler: DesktopIpcEventHandler<Payload>
  ) => void;
  readonly registerInvoke: <Args extends readonly unknown[], Result>(
    domain: DesktopIpcDomain,
    channel: string,
    handler: DesktopIpcInvokeHandler<Args, Result>
  ) => void;
  readonly unregisterAll: () => void;
}

function assertNonEmptyChannel(channel: string): void {
  if (channel.trim().length === 0) {
    throw new Error('Desktop IPC channel must be a non-empty string.');
  }
  if (channel.includes('\0')) {
    throw new Error('Desktop IPC channel must not contain null bytes.');
  }
}

function sortSnapshot(
  registrations: Iterable<DesktopIpcChannelRegistration>
): DesktopIpcChannelRegistration[] {
  const snapshot = [...registrations].map(({ channel, domain, kind }) => ({
    channel,
    domain,
    kind,
  }));
  return snapshot.sort((left, right) => {
    const channelOrder = left.channel.localeCompare(right.channel);
    if (channelOrder !== 0) {
      return channelOrder;
    }
    return left.kind.localeCompare(right.kind);
  });
}

export function createDesktopIpcRegistry({
  ipcMain,
}: DesktopIpcRegistryOptions): DesktopIpcRegistry {
  const registrations = new Map<string, RegisteredChannel>();

  function assertAvailableChannel(channel: string): void {
    assertNonEmptyChannel(channel);
    if (!registrations.has(channel)) {
      return;
    }
    throw new Error(`Desktop IPC channel already registered: ${channel}`);
  }

  function registerInvoke<Args extends readonly unknown[], Result>(
    domain: DesktopIpcDomain,
    channel: string,
    handler: DesktopIpcInvokeHandler<Args, Result>
  ): void {
    assertAvailableChannel(channel);
    ipcMain.handle(channel, handler as DesktopIpcInvokeHandler);
    registrations.set(channel, { channel, domain, kind: 'invoke' });
  }

  function registerEvent<Payload>(
    domain: DesktopIpcDomain,
    channel: string,
    handler: DesktopIpcEventHandler<Payload>
  ): void {
    assertAvailableChannel(channel);
    const eventHandler = handler as DesktopIpcEventHandler;
    ipcMain.on(channel, eventHandler);
    registrations.set(channel, { channel, domain, handler: eventHandler, kind: 'event' });
  }

  function unregisterAll(): void {
    for (const registration of registrations.values()) {
      if (registration.kind === 'invoke') {
        ipcMain.removeHandler(registration.channel);
        continue;
      }
      ipcMain.removeListener(registration.channel, registration.handler);
    }
    registrations.clear();
  }

  return {
    getSnapshot: () => sortSnapshot(registrations.values()),
    registerEvent,
    registerInvoke,
    unregisterAll,
  };
}
