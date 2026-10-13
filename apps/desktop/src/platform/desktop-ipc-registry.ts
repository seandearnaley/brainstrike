import { NativeIndexRefusalError } from '@brainstrike/indexing-contract/indexer-client';
import { createLogger } from '@brainstrike/logging';
import type { ipcMain as ElectronIpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { nativeIndexBoundaryFailure } from '../native-index-boundary-failure';
import { type DesktopWindowRole, getWindowRoleByWebContentsId } from '../window-role';
import {
  type DesktopIpcSenderFrameAllowlist,
  isAllowedDesktopIpcSenderFrameUrl,
  resolveDesktopIpcSenderFrameAllowlist,
} from './desktop-ipc-sender-frame';
import { type Contract, type Handlers, type IpcResult, ipcFailure, ipcOk } from './ipc-contract';

export type DesktopIpcDomain =
  | 'agent'
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
  | 'windowFocus'
  | 'workspace'
  | 'worktrees';

// Main-process-only signal for every authorization rejection (the renderer
// sees a curated error that never echoes its own input). The rejected frame
// URL is renderer-controlled; it is logged here, where the renderer cannot
// read it, so allowlist/launch-mode drift and dev-server pathname mismatches
// are diagnosable instead of silently bricking every authorized channel.
const logger = createLogger('DesktopIpcRegistry');

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

function readSenderFrameUrl(
  channel: string,
  senderFrame: NonNullable<IpcMainInvokeEvent['senderFrame']>
): string {
  // `WebFrameMain.url` is a getter: once the frame is gone Electron throws
  // ("Render frame was disposed before WebFrameMain could be accessed")
  // rather than returning null, so the read is guarded to keep the curated
  // error contract uniform instead of leaking the raw internal message.
  try {
    return senderFrame.url;
  } catch (error) {
    logger.warn('Rejected desktop IPC invoke: sender frame was disposed', {
      channel,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw new Error(`Desktop IPC ${channel} requires a live sender frame.`);
  }
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
    logger.warn('Rejected desktop IPC invoke: no live sender frame', { channel });
    throw new Error(`Desktop IPC ${channel} requires a live sender frame.`);
  }
  const senderFrameUrl = readSenderFrameUrl(channel, senderFrame);
  if (!isAllowedDesktopIpcSenderFrameUrl(allowlist, senderFrameUrl)) {
    logger.warn('Rejected desktop IPC invoke: unrecognized sender frame URL', {
      allowlist,
      channel,
      senderFrameUrl,
    });
    // The URL is renderer-controlled; it is deliberately kept out of the
    // message so the rejection cannot smuggle text into the renderer.
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
        logger.warn('Rejected desktop IPC invoke: sender role not allowed', {
          allowedRoles: policy.roles,
          channel,
          senderId: event.sender.id,
          senderRole: senderRole ?? null,
        });
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

/**
 * Registers every invoke channel of a pure contract (BST-1648). The ONLY
 * verb a contract domain can reach is the authorized one: `spec.roles` is a
 * non-empty tuple, so a contract channel cannot exist without a sender
 * policy. Per channel, authorization runs first (both factors), then
 * `spec.parseArgs` in main (throws on malformed input), then the handler
 * with the parsed tuple. Push events are never registered here — a
 * main→renderer push is a `webContents.send`, not a handler. A contract key
 * without a handler, or a handler without a contract key, is a registration
 * error (fail closed, never a silently dead channel).
 */
export function registerDomain<C extends Contract>(
  registry: Pick<DesktopIpcRegistry, 'registerAuthorizedInvoke'>,
  domain: DesktopIpcDomain,
  contract: C,
  handlers: Handlers<C>
): void {
  const handlerMap = handlers as Record<string, ((...args: never[]) => unknown) | undefined>;
  const invokeKeys = Object.entries(contract).filter(([, spec]) => spec.kind === 'invoke');
  for (const key of Object.keys(handlerMap)) {
    if (!invokeKeys.some(([contractKey]) => contractKey === key)) {
      throw new Error(`Desktop IPC domain ${domain} has a handler "${key}" with no contract key.`);
    }
  }
  // Validate the whole map BEFORE touching the registry: a missing handler
  // must not leave the domain half-registered.
  const registrations = invokeKeys.map(([key, spec]) => {
    const handler = handlerMap[key];
    if (typeof handler !== 'function' || spec.kind !== 'invoke') {
      throw new Error(`Desktop IPC domain ${domain} has no handler for contract key "${key}".`);
    }
    return { invoke: handler as (...args: unknown[]) => unknown, spec };
  });
  for (const { invoke, spec } of registrations) {
    registry.registerAuthorizedInvoke(
      domain,
      spec.channel,
      { roles: spec.roles },
      (_event, ...raw: readonly unknown[]) => {
        if (spec.envelope === 'raw') {
          return invoke(...spec.parseArgs(raw));
        }
        return settleIpcResult({ category: domain, code: spec.channel }, () =>
          invoke(...spec.parseArgs(raw))
        ).then((result) => (result.ok ? result.value : result));
      }
    );
  }
}

/**
 * Runs a throw-style operation inside a contract handler and settles it as
 * an `IpcResult`: a throw becomes `{ ok: false, error: { category, code,
 * message } }` (logged here, in main, with the cause) instead of rejecting
 * across IPC as Electron's formatted string.
 */
export async function settleIpcResult<T>(
  failure: { readonly category: string; readonly code: string },
  run: () => T | Promise<T>
): Promise<IpcResult<T>> {
  try {
    return ipcOk(await run());
  } catch (error) {
    return ipcFailure(
      nativeIndexBoundaryFailure(error, (message, fields) =>
        logger.error(
          message,
          error instanceof NativeIndexRefusalError ? fields : { ...fields, operation: failure }
        )
      )
    );
  }
}
