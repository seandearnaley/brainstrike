/**
 * PURE per-domain IPC contract vocabulary (BST-1648). No `electron`, no
 * `node:*`, no bare package imports: this module is bundled into the
 * sandboxed preloads (`scripts/build-main-config.mjs`, `bundle: true`) AND
 * imported by main, so ONE contract object per domain derives the main
 * handler map (`Handlers<C>`), the preload bridge object (`Bridge<C>`), and
 * the renderer `Window` typing. The method name and its types live here and
 * nowhere else. Main decodes each channel's arguments with the Effect Schema
 * that `ContractArgs<C>` (`ipc-args.ts`, main-only) pins to these types, so
 * Effect never enters a preload. Every call is authorized by the one
 * dispatcher before its arguments are decoded. See
 * `docs/agents/platform-contracts.md`.
 */
import type { BoundaryFailure } from '@brainstrike/assistant-contract/boundary-failure';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';

export type IpcChannelName = `${string}:${string}`;

export function ipcOk<T>(value: T): BoundaryResult<T> {
  return { ok: true, value };
}

export function ipcFailure<T = never>(error: BoundaryFailure): BoundaryResult<T> {
  return { error, ok: false };
}

/**
 * `ipc-result`: the handler returns `BoundaryResult<Result>`; the preload transports the envelope;
 * the renderer capability decodes it into `Promise<Result>`.
 * `raw`: the handler's return value crosses untouched — for domains whose
 * consumers already read the `BoundaryResult` envelope themselves and never
 * throw across IPC.
 */
type IpcEnvelope = 'ipc-result' | 'raw';

export interface IpcChannel<
  Args extends readonly unknown[],
  Result,
  Envelope extends IpcEnvelope = IpcEnvelope,
> {
  /** Phantom carrier for the argument tuple; Main decodes it with `ContractArgs<C>`. */
  readonly args?: Args;
  readonly channel: IpcChannelName;
  readonly envelope: Envelope;
  readonly kind: 'invoke';
  /** Phantom carrier for the unwrapped result type; never assigned. */
  readonly result?: Result;
}

/** One-way main→renderer push; the bridge derives `(callback) => unsubscribe`. */
export interface IpcEvent<Payload> {
  readonly channel: IpcChannelName;
  readonly kind: 'push';
  /** Phantom carrier for the payload type; never assigned. */
  readonly payload?: Payload;
}

type IpcSpec = IpcChannel<readonly unknown[], unknown> | IpcEvent<unknown>;
export type Contract = Record<string, IpcSpec>;

interface IpcChannelInput {
  readonly channel: IpcChannelName;
}

export function channel<Args extends readonly unknown[], Result>(
  spec: IpcChannelInput
): IpcChannel<Args, Result, 'ipc-result'> {
  return { channel: spec.channel, envelope: 'ipc-result', kind: 'invoke' };
}

export function rawChannel<Args extends readonly unknown[], Result>(
  spec: IpcChannelInput
): IpcChannel<Args, Result, 'raw'> {
  return { channel: spec.channel, envelope: 'raw', kind: 'invoke' };
}

export function pushEvent<Payload>(spec: { readonly channel: IpcChannelName }): IpcEvent<Payload> {
  return { channel: spec.channel, kind: 'push' };
}

export type InvokeKeys<C extends Contract> = {
  [K in keyof C]: C[K] extends IpcChannel<readonly unknown[], unknown> ? K : never;
}[keyof C];

/** The main-side handler map: one function per invoke channel, typed by the contract. */
export type Handlers<C extends Contract> = {
  [K in InvokeKeys<C>]: C[K] extends IpcChannel<infer Args, infer Result, infer Envelope>
    ? Envelope extends 'ipc-result'
      ? (...args: Args) => BoundaryResult<Result> | Promise<BoundaryResult<Result>>
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

/** Actual preload transport: invoke results remain envelopes across contextBridge. */
export type TransportBridge<C extends Contract> = {
  [K in keyof C]: C[K] extends IpcChannel<infer Args, infer Result, infer Envelope>
    ? (...args: Args) => Promise<Envelope extends 'ipc-result' ? BoundaryResult<Result> : Result>
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
