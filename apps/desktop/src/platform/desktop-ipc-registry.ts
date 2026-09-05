import type { ipcMain as ElectronIpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { type DesktopWindowRole, getWindowRoleByWebContentsId } from '../window-role';
import {
  type DesktopIpcSenderFrameAllowlist,
  isAllowedDesktopIpcSenderFrameUrl,
  resolveDesktopIpcSenderFrameAllowlist,
} from './desktop-ipc-sender-frame';

export type DesktopIpcDomain =
  | 'agent'
  | 'assistantCheckpoint'
  | 'browser'
  | 'changes'
  | 'chunking-host'
  | 'clipboard'
  | 'commandSessions'
  | 'contextFiles'
  | 'db'
  | 'diagnostics'
  | 'embeddings'
  | 'fileExports'
  | 'files'
  | 'forge'
  | 'git'
  | 'hooks'
  | 'llm-host'
  | 'logging'
  | 'mcp'
  | 'notesVault'
  | 'preferences'
  | 'providerAuth'
  | 'runtime'
  | 'shell'
  | 'skills'
  | 'storage'
  | 'terminal'
  | 'tools'
  | 'userCommands'
  | 'userPersonas'
  | 'vectorPreferences'
  | 'workspace'
  | 'worktrees';

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
  /**
   * Sender-frame allowlist consulted by `registerAuthorizedInvoke`. Omit in
   * production so every registry shares the process-wide allowlist that
   * `main.ts` configures from the resolved launch mode; inject in unit tests
   * so the second factor is exercised without booting Electron.
   */
  readonly senderFrameAllowlist?: DesktopIpcSenderFrameAllowlist;
}

export interface DesktopIpcSenderPolicy {
  readonly roles: readonly DesktopWindowRole[];
}

/**
 * Explicit opt-out from sender authorization. The reason is documentation
 * that survives review: it must say WHY the channel is safe (or tracked) for
 * any renderer that holds the preload, since preload possession is not an
 * authorization boundary (`docs/agents/platform-contracts.md`).
 */
export interface DesktopIpcUnauthenticatedPolicy {
  readonly reason: string;
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
  /**
   * Registers a sensitive invoke channel with a fail-closed, server-owned
   * sender policy. Two factors run before the handler receives or parses any
   * renderer-controlled arguments: `event.sender.id` must map to one of the
   * declared window roles, and `event.senderFrame.url` must match the
   * launch-mode allowlist (a null or missing frame is rejected).
   */
  readonly registerAuthorizedInvoke: <Args extends readonly unknown[], Result>(
    domain: DesktopIpcDomain,
    channel: string,
    policy: DesktopIpcSenderPolicy,
    handler: DesktopIpcInvokeHandler<Args, Result>
  ) => void;
  readonly registerEvent: <Payload>(
    domain: DesktopIpcDomain,
    channel: string,
    handler: DesktopIpcEventHandler<Payload>
  ) => void;
  /**
   * Registers an invoke channel WITHOUT sender authorization. The long name
   * and mandatory reason are deliberate: the safe verb is the short one.
   */
  readonly registerUnauthenticatedInvoke: <Args extends readonly unknown[], Result>(
    domain: DesktopIpcDomain,
    channel: string,
    policy: DesktopIpcUnauthenticatedPolicy,
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

function assertSenderPolicy(policy: DesktopIpcSenderPolicy): void {
  if (policy.roles.length === 0) {
    throw new Error('Desktop IPC sender policy must allow at least one window role.');
  }
  if (new Set(policy.roles).size !== policy.roles.length) {
    throw new Error('Desktop IPC sender policy must not contain duplicate window roles.');
  }
}

function assertUnauthenticatedPolicy(policy: DesktopIpcUnauthenticatedPolicy): void {
  if (typeof policy.reason !== 'string' || policy.reason.trim().length === 0) {
    throw new Error('Desktop IPC unauthenticated registration requires a non-empty reason.');
  }
}

function formatRequiredSenderRoles(roles: readonly DesktopWindowRole[]): string {
  return roles.join(', ');
}

function assertAuthorizedSenderFrame(
  channel: string,
  allowlist: DesktopIpcSenderFrameAllowlist,
  senderFrame: IpcMainInvokeEvent['senderFrame'] | undefined
): void {
  // Electron documents `senderFrame` as null once the frame navigated away or
  // was destroyed; an undefined property is an event that never carried one.
  // Both are unverifiable and fail closed.
  if (!senderFrame) {
    throw new Error(`Desktop IPC ${channel} requires a live sender frame.`);
  }
  if (!isAllowedDesktopIpcSenderFrameUrl(allowlist, senderFrame.url)) {
    // The URL is renderer-controlled; it is deliberately kept out of the
    // message so the rejection cannot smuggle text into logs or the renderer.
    throw new Error(`Desktop IPC ${channel} rejected an unrecognized sender frame URL.`);
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
  senderFrameAllowlist,
}: DesktopIpcRegistryOptions): DesktopIpcRegistry {
  const registrations = new Map<string, RegisteredChannel>();
  const resolveSenderFrameAllowlist = (): DesktopIpcSenderFrameAllowlist =>
    senderFrameAllowlist ?? resolveDesktopIpcSenderFrameAllowlist();

  function assertAvailableChannel(channel: string): void {
    assertNonEmptyChannel(channel);
    if (!registrations.has(channel)) {
      return;
    }
    throw new Error(`Desktop IPC channel already registered: ${channel}`);
  }

  function registerInvokeChannel<Args extends readonly unknown[], Result>(
    domain: DesktopIpcDomain,
    channel: string,
    handler: DesktopIpcInvokeHandler<Args, Result>
  ): void {
    assertAvailableChannel(channel);
    ipcMain.handle(channel, handler as DesktopIpcInvokeHandler);
    registrations.set(channel, { channel, domain, kind: 'invoke' });
  }

  function registerUnauthenticatedInvoke<Args extends readonly unknown[], Result>(
    domain: DesktopIpcDomain,
    channel: string,
    policy: DesktopIpcUnauthenticatedPolicy,
    handler: DesktopIpcInvokeHandler<Args, Result>
  ): void {
    assertUnauthenticatedPolicy(policy);
    registerInvokeChannel(domain, channel, handler);
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

  function registerAuthorizedInvoke<Args extends readonly unknown[], Result>(
    domain: DesktopIpcDomain,
    channel: string,
    policy: DesktopIpcSenderPolicy,
    handler: DesktopIpcInvokeHandler<Args, Result>
  ): void {
    assertSenderPolicy(policy);
    const allowedRoles = new Set(policy.roles);
    registerInvokeChannel(domain, channel, async (event, ...args: Args) => {
      const senderRole = getWindowRoleByWebContentsId(event.sender.id);
      if (!(senderRole && allowedRoles.has(senderRole))) {
        throw new Error(
          `Desktop IPC ${channel} requires sender role ${formatRequiredSenderRoles(policy.roles)}.`
        );
      }
      assertAuthorizedSenderFrame(channel, resolveSenderFrameAllowlist(), event.senderFrame);
      return await handler(event, ...args);
    });
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
    registerAuthorizedInvoke,
    registerEvent,
    registerUnauthenticatedInvoke,
    unregisterAll,
  };
}
