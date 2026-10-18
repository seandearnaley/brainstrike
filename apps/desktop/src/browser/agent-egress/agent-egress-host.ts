/**
 * Main's owner of the agent egress utility process (BST-1238). It forks the
 * proxy on first need, hands it a per-launch credential, and keeps the
 * proxy's recent refusals so a failed agent navigation can name its cause.
 *
 * A proxy that exits leaves the agent partition pointing at a dead port, so
 * agent tabs fail to connect (visibly) until the next {@link ensure}, which
 * starts a fresh proxy.
 */
import { randomBytes } from 'node:crypto';
import { decodeEgressEvent, type EgressEvent } from './egress-protocol';
import type { EgressRefusal } from './egress-proxy';

/** The slice of Electron's `UtilityProcess` this owner drives. */
export interface EgressUtility {
  kill(): boolean;
  on(event: 'message', listener: (message: unknown) => void): void;
  once(event: 'exit', listener: (code: number) => void): void;
  postMessage(message: unknown): void;
}

export interface AgentEgress {
  readonly password: string;
  readonly port: number;
  readonly username: string;
}

interface Current {
  readonly exited: Promise<void>;
  readonly ready: Promise<AgentEgress>;
  readonly utility: EgressUtility;
}

const USERNAME = 'agent';
const REFUSALS_KEPT = 64;

export class AgentEgressHost {
  #current: Current | undefined;
  readonly #refusals = new Map<string, EgressRefusal>();
  readonly #fork: () => EgressUtility;
  readonly #startupTimeoutMs: number;

  constructor(fork: () => EgressUtility, startupTimeoutMs = 10_000) {
    this.#fork = fork;
    this.#startupTimeoutMs = startupTimeoutMs;
  }

  /** The running proxy, started (or restarted after an exit) on demand. */
  ensure(): Promise<AgentEgress> {
    this.#current ??= this.#start();
    return this.#current.ready;
  }

  /** The proxy's most recent refusal of `host`, if it refused one. */
  refusalFor(host: string): EgressRefusal | undefined {
    return this.#refusals.get(host.toLowerCase());
  }

  /** Stop the proxy and join its exit. */
  async close(): Promise<void> {
    const current = this.#current;
    this.#current = undefined;
    if (current !== undefined) {
      current.utility.kill();
      await current.exited;
    }
  }

  #remember(refusal: EgressRefusal): void {
    const key = refusal.reason === 'malformed' ? refusal.target : refusal.host;
    this.#refusals.delete(key);
    this.#refusals.set(key, refusal);
    if (this.#refusals.size > REFUSALS_KEPT) {
      const oldest = this.#refusals.keys().next();
      if (oldest.done !== true) {
        this.#refusals.delete(oldest.value);
      }
    }
  }

  #start(): Current {
    const utility = this.#fork();
    const password = randomBytes(32).toString('hex');
    const exit = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<AgentEgress>();
    const timer = setTimeout(() => {
      ready.reject(new Error('The agent browsing proxy did not start in time'));
      utility.kill();
    }, this.#startupTimeoutMs);
    const current: Current = { exited: exit.promise, ready: ready.promise, utility };
    utility.once('exit', () => {
      clearTimeout(timer);
      // Settles only a start still in flight; a ready proxy keeps its answer.
      ready.reject(new Error('The agent browsing proxy exited before it was ready'));
      if (this.#current === current) {
        this.#current = undefined;
      }
      exit.resolve();
    });
    utility.on('message', (message) => {
      let event: EgressEvent;
      try {
        event = decodeEgressEvent(message);
      } catch (cause) {
        // A proxy that speaks out of protocol is not trusted to keep routing.
        ready.reject(new Error('The agent browsing proxy sent an invalid message', { cause }));
        utility.kill();
        return;
      }
      switch (event.type) {
        case 'refusal':
          this.#remember(event.refusal);
          return;
        case 'ready':
          clearTimeout(timer);
          ready.resolve({ password, port: event.port, username: USERNAME });
          return;
        case 'failed':
          ready.reject(new Error(`The agent browsing proxy failed to start: ${event.message}`));
          utility.kill();
          return;
      }
    });
    utility.postMessage({ credential: `${USERNAME}:${password}`, type: 'start' });
    return current;
  }
}
