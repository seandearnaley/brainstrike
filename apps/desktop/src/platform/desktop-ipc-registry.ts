import { toBoundaryFailure } from '@brainstrike/agent-host/boundary-wire';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { createLogger } from '@brainstrike/logging';
import type { Schema } from 'effect';
import type { ipcMain as ElectronIpcMain, IpcMainInvokeEvent } from 'electron';
import { isAppWindowSender } from '../app-windows';
import { isExpectedShutdownRefusal } from '../desktop-shutdown-state';
import { DESKTOP_IPC_INVOKE_CHANNEL } from './desktop-ipc-channels';
import {
  type DesktopIpcSenderFrameAllowlist,
  isAllowedDesktopIpcSenderFrameUrl,
  resolveDesktopIpcSenderFrameAllowlist,
} from './desktop-ipc-sender-frame';
import { type ContractArgs, ipcArgsDecoder } from './ipc-args';
import { type Contract, type Handlers, ipcFailure, ipcOk } from './ipc-contract';

export type DesktopIpcDomain =
  | 'threadGroups'
  | 'viewFilterPresets'
  | 'agent'
  | 'appLifetime'
  | 'appUpdates'
  | 'browser'
  | 'chatGptSignIn'
  | 'clipboard'
  | 'db'
  | 'diagnostics'
  | 'fileExports'
  | 'files'
  | 'hooks'
  | 'logging'
  | 'mcp'
  | 'modelCatalog'
  | 'preferences'
  | 'runtime'
  | 'shell'
  | 'tools'
  | 'windowFocus'
  | 'workspace';

// Main-process-only signal for every authorization rejection (the renderer
// sees a curated error that never echoes its own input). The rejected frame
// URL is renderer-controlled; it is logged here, where the renderer cannot
// read it, so allowlist/launch-mode drift and dev-server pathname mismatches
// are diagnosable instead of silently bricking every authorized method.
const logger = createLogger('DesktopIpcRegistry');

export interface DesktopIpcChannelRegistration {
  readonly channel: string;
  readonly domain: DesktopIpcDomain;
}

/** A decoded argument tuple, writable so a handler may name its parameters. */
type HandlerArgs<Args extends readonly unknown[]> = { -readonly [K in keyof Args]: Args[K] };

type DesktopIpcHandler<Args extends readonly unknown[] = readonly unknown[], Result = unknown> = (
  event: IpcMainInvokeEvent,
  ...args: HandlerArgs<Args>
) => Promise<Result> | Result;

interface DesktopIpcMainLike {
  readonly handle: typeof ElectronIpcMain.handle;
}

interface DesktopIpcRegistryOptions {
  readonly ipcMain: DesktopIpcMainLike;
  /**
   * Sender-frame allowlist the dispatcher checks. Omit in production so every
   * call shares the process-wide allowlist that `main.ts` configures from the
   * resolved launch mode; inject in unit tests so the second factor is
   * exercised without booting Electron.
   */
  readonly senderFrameAllowlist?: DesktopIpcSenderFrameAllowlist;
}

export interface DesktopIpcRegistry {
  readonly getSnapshot: () => DesktopIpcChannelRegistration[];
  /**
   * Serves one method on the desktop's one IPC connection. Before any
   * renderer-controlled argument is read, the dispatcher checks both sender
   * factors: `event.sender.id` must be a tracked app window, and
   * `event.senderFrame.url` must match the launch-mode allowlist (a null or
   * missing frame is rejected). It then decodes the arguments with `args`
   * and hands the handler the decoded tuple.
   */
  readonly handle: <Args extends readonly unknown[], Result>(
    domain: DesktopIpcDomain,
    method: string,
    args: Schema.Decoder<Args>,
    handler: DesktopIpcHandler<Args, Result>
  ) => void;
  readonly unregisterAll: () => void;
}

interface DesktopIpcRoute extends DesktopIpcChannelRegistration {
  readonly decodeArgs: (raw: readonly unknown[]) => readonly unknown[];
  readonly handler: DesktopIpcHandler;
}

interface DesktopIpcConnection {
  readonly routes: Map<string, DesktopIpcRoute>;
  senderFrameAllowlist: DesktopIpcSenderFrameAllowlist | undefined;
}

/** One dispatcher and route table per Electron `ipcMain`: the app has exactly one. */
const connections = new WeakMap<DesktopIpcMainLike, DesktopIpcConnection>();

function readSenderFrameUrl(
  method: string,
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
      errorMessage: error instanceof Error ? error.message : String(error),
      method,
    });
    throw new Error(`Desktop IPC ${method} requires a live sender frame.`);
  }
}

function assertAuthorizedSender(
  method: string,
  allowlist: DesktopIpcSenderFrameAllowlist,
  event: IpcMainInvokeEvent
): void {
  if (!isAppWindowSender(event.sender.id)) {
    logger.warn('Rejected desktop IPC invoke: sender is not an app window', {
      method,
      senderId: event.sender.id,
    });
    throw new Error(`Desktop IPC ${method} requires an app window sender.`);
  }
  // Electron documents `senderFrame` as null once the frame navigated away or
  // was destroyed; an undefined property is an event that never carried one.
  // Both are unverifiable and fail closed.
  const senderFrame = event.senderFrame;
  if (!senderFrame) {
    logger.warn('Rejected desktop IPC invoke: no live sender frame', { method });
    throw new Error(`Desktop IPC ${method} requires a live sender frame.`);
  }
  const senderFrameUrl = readSenderFrameUrl(method, senderFrame);
  if (!isAllowedDesktopIpcSenderFrameUrl(allowlist, senderFrameUrl)) {
    logger.warn('Rejected desktop IPC invoke: unrecognized sender frame URL', {
      allowlist,
      method,
      senderFrameUrl,
    });
    // The URL is renderer-controlled; it is deliberately kept out of the
    // message so the rejection cannot smuggle text into the renderer.
    throw new Error(`Desktop IPC ${method} rejected an unrecognized sender frame URL.`);
  }
}

function openConnection(
  ipcMain: DesktopIpcMainLike,
  senderFrameAllowlist: DesktopIpcSenderFrameAllowlist | undefined
): DesktopIpcConnection {
  const existing = connections.get(ipcMain);
  if (existing) {
    existing.senderFrameAllowlist ??= senderFrameAllowlist;
    return existing;
  }
  const connection: DesktopIpcConnection = { routes: new Map(), senderFrameAllowlist };
  connections.set(ipcMain, connection);
  ipcMain.handle(DESKTOP_IPC_INVOKE_CHANNEL, async (event, method: unknown, ...args: unknown[]) => {
    if (typeof method !== 'string') {
      throw new Error('Desktop IPC requires a method name.');
    }
    assertAuthorizedSender(
      method,
      connection.senderFrameAllowlist ?? resolveDesktopIpcSenderFrameAllowlist(),
      event
    );
    const route = connection.routes.get(method);
    if (!route) {
      throw new Error(`No desktop IPC handler for ${method}.`);
    }
    let decoded: readonly unknown[];
    try {
      decoded = route.decodeArgs(args);
    } catch (error) {
      logger.warn('Rejected desktop IPC invoke: invalid arguments', {
        errorMessage: error instanceof Error ? error.message : String(error),
        method,
      });
      throw error;
    }
    return await route.handler(event, ...decoded);
  });
  return connection;
}

export function createDesktopIpcRegistry({
  ipcMain,
  senderFrameAllowlist,
}: DesktopIpcRegistryOptions): DesktopIpcRegistry {
  const connection = openConnection(ipcMain, senderFrameAllowlist);
  const owned = new Map<string, DesktopIpcRoute>();

  return {
    getSnapshot: () =>
      [...owned.values()]
        .map(({ channel, domain }) => ({ channel, domain }))
        .sort((left, right) => left.channel.localeCompare(right.channel)),
    handle: (domain, method, args, handler) => {
      if (method.trim().length === 0 || method.includes('\0')) {
        throw new Error('Desktop IPC method must be a non-empty string without null bytes.');
      }
      if (connection.routes.has(method)) {
        throw new Error(`Desktop IPC method already registered: ${method}`);
      }
      const route: DesktopIpcRoute = {
        channel: method,
        decodeArgs: ipcArgsDecoder(method, args),
        domain,
        handler: handler as DesktopIpcHandler,
      };
      connection.routes.set(method, route);
      owned.set(method, route);
    },
    unregisterAll: () => {
      for (const [method, route] of owned) {
        if (connection.routes.get(method) === route) {
          connection.routes.delete(method);
        }
      }
      owned.clear();
    },
  };
}

/**
 * Registers every invoke method of a pure contract (BST-1648). Per call, the
 * dispatcher's authorization runs first (both factors), then the channel's
 * argument schema from `args` (rejects malformed input), then the handler with
 * the decoded tuple. Push events are
 * never registered here: a main→renderer push is `pushToRenderer`, not a handler. A contract key
 * without a handler, or a handler without a contract key, is a registration
 * error (fail closed, never a silently dead channel).
 */
export function registerDomain<C extends Contract>(
  registry: Pick<DesktopIpcRegistry, 'handle'>,
  domain: DesktopIpcDomain,
  contract: C,
  args: ContractArgs<C>,
  handlers: Handlers<C>
): void {
  const handlerMap = handlers as Record<string, ((...args: never[]) => unknown) | undefined>;
  const argsMap = args as Record<string, Schema.Decoder<readonly unknown[]> | undefined>;
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
    const argsSchema = argsMap[key];
    if (argsSchema === undefined) {
      throw new Error(`Desktop IPC domain ${domain} has no argument schema for "${key}".`);
    }
    return { argsSchema, invoke: handler as (...decoded: unknown[]) => unknown, spec };
  });
  for (const { argsSchema, invoke, spec } of registrations) {
    registry.handle(domain, spec.channel, argsSchema, (_event, ...decoded) => {
      if (spec.envelope === 'raw') {
        return invoke(...decoded);
      }
      return settleIpcResult({ category: domain, code: spec.channel }, () =>
        invoke(...decoded)
      ).then((result) => (result.ok ? result.value : result));
    });
  }
}

/**
 * Runs a throw-style operation inside a contract handler and settles it as
 * a `BoundaryResult`: a throw becomes `{ ok: false, error: { category, code,
 * message } }` (logged here, in main, with the cause) instead of rejecting
 * across IPC as Electron's formatted string.
 */
export async function settleIpcResult<T>(
  failure: { readonly category: string; readonly code: string },
  run: () => T | Promise<T>
): Promise<BoundaryResult<T>> {
  try {
    return ipcOk(await run());
  } catch (error) {
    const quitting = isExpectedShutdownRefusal(error);
    return ipcFailure(
      toBoundaryFailure(error, (message, fields) => {
        const details = { ...fields, operation: failure };
        // ADR-0015: work refused because the app is quitting is the expected outcome.
        if (quitting) {
          logger.info(message, details);
        } else {
          logger.error(message, details);
        }
      })
    );
  }
}
