/**
 * PURE per-domain IPC contract vocabulary (BST-1648). No `electron`, no
 * `node:*`, no bare package imports: this module is bundled into the
 * sandboxed preloads (`scripts/build-main-config.mjs`, `bundle: true`) AND
 * imported by main, so ONE contract object per domain derives the main
 * handler map (`Handlers<C>`), the preload bridge object (`Bridge<C>`), and
 * the renderer `Window` typing. The channel string lives here and nowhere
 * else; `parseArgs` is a plain function that runs only in MAIN, before the
 * handler sees renderer-controlled input, and THROWS on malformed input (no
 * coercion). Sender roles are a non-empty tuple: a contract channel cannot
 * be registered without authorization (`registerDomain` has no
 * unauthenticated path). See `docs/agents/platform-contracts.md`.
 */
import type { DesktopWindowRole } from '../window-role';

export type IpcChannelName = `${string}:${string}`;
export type IpcSenderRoles = readonly [DesktopWindowRole, ...DesktopWindowRole[]];

/**
 * The ONE failure taxonomy that crosses IPC as data (first written for MCP
 * content IPC, now an agent-host method). `ipcMain.handle` replies to a thrown Error with
 * Electron's formatted string, main-process stack included, so failures
 * travel as an envelope and the preload rebuilds a clean Error carrying
 * exactly these three fields.
 */
export interface IpcFailure {
  readonly category: string;
  readonly code: string;
  readonly message: string;
}

export type IpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly error: IpcFailure; readonly ok: false };

export function ipcOk<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

export function ipcFailure<T = never>(
  category: string,
  code: string,
  message: string
): IpcResult<T> {
  return { error: { category, code, message }, ok: false };
}

/**
 * `ipc-result`: the handler returns `IpcResult<Result>`; the preload bridge
 * unwraps it into `Promise<Result>` and throws a clean Error on `ok: false`.
 * `raw`: the handler's return value crosses untouched — for domains whose
 * consumers already read a typed envelope of their own (`GitResult`,
 * `TerminalResult`, `NotesVaultResult`) and never throw across IPC.
 */
export type IpcEnvelope = 'ipc-result' | 'raw';

export interface IpcChannel<
  Args extends readonly unknown[],
  Result,
  Envelope extends IpcEnvelope = IpcEnvelope,
> {
  readonly channel: IpcChannelName;
  readonly envelope: Envelope;
  readonly kind: 'invoke';
  /** Runs in MAIN before the handler; throws on malformed renderer input. */
  readonly parseArgs: (raw: readonly unknown[]) => Args;
  /** Phantom carrier for the unwrapped result type; never assigned. */
  readonly result?: Result;
  readonly roles: IpcSenderRoles;
}

/** One-way main→renderer push; the bridge derives `(callback) => unsubscribe`. */
export interface IpcEvent<Payload> {
  readonly channel: IpcChannelName;
  readonly kind: 'push';
  /** Phantom carrier for the payload type; never assigned. */
  readonly payload?: Payload;
}

export type IpcSpec = IpcChannel<readonly unknown[], unknown> | IpcEvent<unknown>;
export type Contract = Record<string, IpcSpec>;

interface IpcChannelInput<Args extends readonly unknown[]> {
  readonly channel: IpcChannelName;
  readonly parseArgs: (raw: readonly unknown[]) => Args;
  readonly roles: IpcSenderRoles;
}

export function channel<Args extends readonly unknown[], Result>(
  spec: IpcChannelInput<Args>
): IpcChannel<Args, Result, 'ipc-result'> {
  return { ...spec, envelope: 'ipc-result', kind: 'invoke' };
}

export function rawChannel<Args extends readonly unknown[], Result>(
  spec: IpcChannelInput<Args>
): IpcChannel<Args, Result, 'raw'> {
  return { ...spec, envelope: 'raw', kind: 'invoke' };
}

export function pushEvent<Payload>(spec: { readonly channel: IpcChannelName }): IpcEvent<Payload> {
  return { channel: spec.channel, kind: 'push' };
}

/** `parseArgs` for a channel that takes no renderer input. */
export function parseNoArgs(): [] {
  return [];
}

type InvokeKeys<C extends Contract> = {
  [K in keyof C]: C[K] extends IpcChannel<readonly unknown[], unknown> ? K : never;
}[keyof C];

/** The main-side handler map: one function per invoke channel, typed by the contract. */
export type Handlers<C extends Contract> = {
  [K in InvokeKeys<C>]: C[K] extends IpcChannel<infer Args, infer Result, infer Envelope>
    ? Envelope extends 'ipc-result'
      ? (...args: Args) => IpcResult<Result> | Promise<IpcResult<Result>>
      : (...args: Args) => Promise<Result> | Result
    : never;
};

/** The renderer-facing bridge object the preload exposes, typed by the contract. */
export type Bridge<C extends Contract> = {
  [K in keyof C]: C[K] extends IpcChannel<infer Args, infer Result, IpcEnvelope>
    ? (...args: Args) => Promise<Result>
    : C[K] extends IpcEvent<infer Payload>
      ? (callback: (payload: Payload) => void) => () => void
      : never;
};

/**
 * Compile-time proof that a contract's derived bridge is exactly the shape a
 * shared package interface declares (mutual assignability, so a missing or
 * extra key on either side fails `tsc`). Contract modules export
 * `type XBridgeDerivationProof = AssertTrue<BridgeMatches<typeof xContract, XBridge>>;`
 * — a false result violates the `extends true` constraint at compile time,
 * and an exported type needs no runtime value.
 */
export type BridgeMatches<C extends Contract, Expected> = [Bridge<C>] extends [Expected]
  ? [Expected] extends [Bridge<C>]
    ? true
    : false
  : false;

/** Compile-time assertion carrier: `AssertTrue<false>` is a type error. */
export type AssertTrue<T extends true> = T;
