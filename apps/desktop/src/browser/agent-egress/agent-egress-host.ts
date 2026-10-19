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
/**
 * A refused CONNECT fails its navigation within milliseconds; older refusals
 * are not evidence about a later failure to the same host.
 */
const REFUSAL_FRESH_MS = 5000;

interface RecordedRefusal {
  readonly at: number;
  readonly refusal: EgressRefusal;
}

export class AgentEgressHost {
  #current: Current | undefined;
  readonly #refusals = new Map<string, RecordedRefusal>();
  readonly #fork: () => EgressUtility;
  readonly #startupTimeoutMs: number;
  readonly #now: () => number;

  constructor(fork: () => EgressUtility, startupTimeoutMs = 10_000, now: () => number = Date.now) {
    this.#fork = fork;
    this.#startupTimeoutMs = startupTimeoutMs;
    this.#now = now;
  }

  /** The running proxy, started (or restarted after an exit) on demand. */
  ensure(): Promise<AgentEgress> {
    this.#current ??= this.#start();
    return this.#current.ready;
  }

  /**
   * Take the running proxy's refusal of `host` from the last few seconds, if
   * any. A tunnel failure is attributed to a refusal at most once, and never to
   * one from an earlier attempt or an earlier proxy.
   */
  takeRefusal(host: string): EgressRefusal | undefined {
    const key = host.toLowerCase();
    const recorded = this.#refusals.get(key);
    this.#refusals.delete(key);
    return recorded !== undefined && this.#now() - recorded.at <= REFUSAL_FRESH_MS
      ? recorded.refusal
      : undefined;
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
    this.#refusals.set(key, { at: this.#now(), refusal });
    if (this.#refusals.size > REFUSALS_KEPT) {
      const oldest = this.#refusals.keys().next();
      if (oldest.done !== true) {
        this.#refusals.delete(oldest.value);
      }
    }
  }

  #start(): Current {
    this.#refusals.clear();
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
