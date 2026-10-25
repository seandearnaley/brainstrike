import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { createLogger } from '@brainstrike/logging';
import type { MessageConnection } from 'vscode-jsonrpc';
import type {
  ForkLentUtility,
  LentUtility,
  LentUtilityEvent,
  LentUtilityListeners,
  LentUtilityPort,
} from '../lent-utility';
import {
  PLATFORM_UTILITY_ERRORED,
  PLATFORM_UTILITY_EXITED,
  PLATFORM_UTILITY_SPAWNED,
  PlatformUtilityErroredSchema,
  PlatformUtilityExitedSchema,
  PlatformUtilitySpawnedSchema,
} from './utility-lending-wire';

const logger = createLogger('HostLentUtility');

/**
 * An index utility Main forked for this host (ADR-0030 decision 1). Main spawns it and joins its
 * exit; this host speaks its protocol over the channel end Main transferred here. What the owner
 * posts before that end arrives waits for it, as Electron queues a message posted before `spawn`.
 */
class HostLentUtility implements LentUtility {
  readonly #events = new EventEmitter();
  readonly #kill: () => void;
  #pid: number | undefined;
  #port: LentUtilityPort | undefined;
  #queued: unknown[] | undefined = [];
  #ended = false;

  constructor(kill: () => void) {
    this.#kill = kill;
  }

  get pid(): number | undefined {
    return this.#pid;
  }

  kill(): boolean {
    if (!this.#ended) {
      this.#kill();
    }
    return true;
  }

  off<Event extends LentUtilityEvent>(event: Event, listener: LentUtilityListeners[Event]): this {
    this.#events.off(event, listener);
    return this;
  }

  on<Event extends LentUtilityEvent>(event: Event, listener: LentUtilityListeners[Event]): this {
    this.#events.on(event, listener);
    return this;
  }

  once<Event extends LentUtilityEvent>(event: Event, listener: LentUtilityListeners[Event]): this {
    this.#events.once(event, listener);
    return this;
  }

  postMessage(message: unknown): void {
    if (this.#port) {
      this.#port.postMessage(message);
      return;
    }
    this.#queued?.push(message);
  }

  attach(port: LentUtilityPort): void {
    if (this.#ended) {
      port.close();
      return;
    }
    this.#port = port;
    port.on('message', (event) => this.#events.emit('message', event.data));
    port.start();
    for (const message of this.#queued ?? []) {
      port.postMessage(message);
    }
    this.#queued = undefined;
  }

  spawned(pid: number | undefined): void {
    this.#pid = pid;
    this.#events.emit('spawn');
  }

  errored(type: string, location: string, report: string): void {
    this.#events.emit('error', type, location, report);
  }

  exited(code: number): void {
    if (this.#ended) {
      return;
    }
    this.#ended = true;
    this.#queued = undefined;
    this.#port?.close();
    this.#events.emit('exit', code);
  }
}

export interface HostUtilityLending {
  /** Main transferred a utility's channel end. */
  attachPort(utilityId: string, port: LentUtilityPort): void;
  errored(utilityId: string, type: string, location: string, report: string): void;
  exited(utilityId: string, code: number): void;
  /** The fork this host's index owners use. */
  readonly fork: ForkLentUtility;
  spawned(utilityId: string, pid: number | undefined): void;
}

/** The fork, kill and lifecycle requests this host's utility lending sends to Main. */
interface MainUtilityRequests {
  fork(request: {
    readonly env: Readonly<Record<string, string>>;
    readonly kind: Parameters<ForkLentUtility>[0];
    readonly utilityId: string;
  }): Promise<void>;
  kill(utilityId: string): Promise<void>;
}

export function createHostUtilityLending(main: MainUtilityRequests): HostUtilityLending {
  const live = new Map<string, HostLentUtility>();
  const lent = (utilityId: string): HostLentUtility | undefined => {
    const utility = live.get(utilityId);
    if (!utility) {
      logger.warn('Main reported a utility this host does not hold', { utilityId });
    }
    return utility;
  };
  return {
    attachPort: (utilityId, port) => {
      const utility = live.get(utilityId);
      if (!utility) {
        port.close();
        logger.warn('Main transferred the channel of a utility this host does not hold', {
          utilityId,
        });
        return;
      }
      utility.attach(port);
    },
    errored: (utilityId, type, location, report) =>
      lent(utilityId)?.errored(type, location, report),
    exited: (utilityId, code) => {
      const utility = lent(utilityId);
      live.delete(utilityId);
      utility?.exited(code);
    },
    fork: (kind, options) => {
      const utilityId = randomUUID();
      const utility = new HostLentUtility(() => {
        main.kill(utilityId).catch((cause: unknown) => {
          logger.error('Main did not end a utility this host released', { cause, kind, utilityId });
        });
      });
      live.set(utilityId, utility);
      main.fork({ env: options.env ?? {}, kind, utilityId }).catch((cause: unknown) => {
        // Never started: the owner sees an exit before any spawn, as for a failed fork.
        logger.error('Main could not start an index utility for this host', { cause, kind });
        live.delete(utilityId);
        utility.exited(1);
      });
      return utility;
    },
    spawned: (utilityId, pid) => lent(utilityId)?.spawned(pid),
  };
}

const strict = { errors: 'all', onExcessProperty: 'error' } as const;
const decodeSpawned = wireDecoder(PlatformUtilitySpawnedSchema, strict);
const decodeErrored = wireDecoder(PlatformUtilityErroredSchema, strict);
const decodeExited = wireDecoder(PlatformUtilityExitedSchema, strict);

/** Main's reports of the utilities it lent this host. */
export function serveUtilityReports(
  connection: MessageConnection,
  lending: HostUtilityLending
): void {
  connection.onNotification(PLATFORM_UTILITY_SPAWNED, (params: unknown) => {
    const { pid, utilityId } = decodeSpawned(params);
    lending.spawned(utilityId, pid ?? undefined);
  });
  connection.onNotification(PLATFORM_UTILITY_ERRORED, (params: unknown) => {
    const { location, report, type, utilityId } = decodeErrored(params);
    lending.errored(utilityId, type, location, report);
  });
  connection.onNotification(PLATFORM_UTILITY_EXITED, (params: unknown) => {
    const { code, utilityId } = decodeExited(params);
    lending.exited(utilityId, code);
  });
}
