/** The index utilities Main forks for an owner (ADR-0030 decision 1). */
export type LentUtilityKind = 'indexer' | 'index-query' | 'index-coverage';

/** The listener of each event, shaped as Electron's `UtilityProcess` emits it. */
export interface LentUtilityListeners {
  readonly error: (type: string, location: string, report: string) => void;
  readonly exit: (code: number) => void;
  readonly message: (message: unknown) => void;
  readonly spawn: () => void;
}
export type LentUtilityEvent = keyof LentUtilityListeners;

/**
 * An Electron utility Main forked and lent to its owner: exactly what an owner uses. Its protocol
 * runs over a MessagePort transferred to the child, so the owner may live in any process Main
 * hands that port to. `exit` is reported only once the utility's OS exit has been joined.
 */
export interface LentUtility {
  /** A request (ADR-0030 decision 3); true once Main owns ending the process. */
  kill(): boolean;
  off<Event extends LentUtilityEvent>(event: Event, listener: LentUtilityListeners[Event]): this;
  on<Event extends LentUtilityEvent>(event: Event, listener: LentUtilityListeners[Event]): this;
  once<Event extends LentUtilityEvent>(event: Event, listener: LentUtilityListeners[Event]): this;
  readonly pid: number | undefined;
  /** Queued until the child takes its port, as Electron queues a message posted before `spawn`. */
  postMessage(message: unknown): void;
}

/** Main's one way to start an index utility; `env` is added to Main's own environment. */
export type ForkLentUtility = (
  kind: LentUtilityKind,
  options: { readonly env?: Readonly<Record<string, string>> }
) => LentUtility;

/** The first message a lent utility receives on its parent port, carrying its one channel. */
export const UTILITY_PORT_EVENT = 'utility-port';

/** The owner's end of a utility's channel: Electron's `MessagePortMain` surface. */
export interface LentUtilityPort {
  close(): void;
  on(event: 'message', listener: (event: { readonly data: unknown }) => void): unknown;
  postMessage(message: unknown): void;
  start(): void;
}
