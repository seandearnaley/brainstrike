import type { IndexerOptions, IndexerPort, ScopedIndexerPort } from '@brainstrike/indexer';
import type { CoverageAuthorityPort } from '@brainstrike/indexer/coverage-reader';
import type { IndexerConnection, IndexerDeadlines } from '@brainstrike/indexer/transport';
import { createLogger } from '@brainstrike/logging';
import { app } from 'electron';
import { resolveBundledSiblingPath } from './bundled-sibling-path';
import {
  type CanonicalRemoteWorkspaceDependencies,
  CanonicalUtilityParent,
  type CanonicalWorkspaceAttachment,
} from './canonical-utility-parent';
import { assertCanonicalMessageBound, isCanonicalFrame } from './canonical-utility-protocol';
import { forkUtility } from './fork-utility';
import { IndexerUtilityExitedError } from './indexer-utility-exit';
import type { LifecycleDelaySeam } from './lifecycle-delay-seam';
import { NativeAuthorityTransitionError } from './native-authority-transition';

const logger = createLogger('IndexerHostManager');

/**
 * Main owns lifecycle only. SQLite and its writer worker belong to the utility process.
 *
 * Liveness is the utility's exit (lifecycle R2): no request, attach or scan has a deadline, and
 * admission closes only on `close()`, `destroy()`, the exit, or a transport/protocol fault that
 * retires the utility. The one clock is the close ladder's (R5(b)): a cooperative retirement of
 * the canonical attachments that has not finished `closeMs` after it began kills the utility, and
 * the attachments then settle on that exit.
 */
export class IndexerHostManager {
  readonly databasePath: string;
  readonly acquisitionEmbedding: IndexerOptions['embedding'];
  readonly rootIds: readonly string[];
  readonly #options: IndexerOptions;
  readonly #deadlines: IndexerDeadlines;
  readonly #entryPath: string;
  readonly #lifecycleDelays: (() => LifecycleDelaySeam) | undefined;
  #connection: IndexerConnection | undefined;
  #start: Promise<IndexerPort & ScopedIndexerPort & CoverageAuthorityPort> | undefined;
  #canonical: CanonicalUtilityParent | undefined;
  #kill: (() => boolean) | undefined;
  #exitCleanup: Promise<void> | undefined;
  #exitCleanupFailed = false;
  #transportFailure: unknown;
  #closed = false;
  #sourceRetirement: Promise<void> | undefined;
  #sourceRetirementOwned = false;
  /** Counts fences. An acquisition a fence overtook belongs to the fenced graph (BST-2140). */
  #fences = 0;

  private constructor(
    options: IndexerOptions,
    deadlines: IndexerDeadlines,
    entryPath: string,
    lifecycleDelays: (() => LifecycleDelaySeam) | undefined
  ) {
    const embedding =
      options.embedding.indexMode === 'vector-configured'
        ? Object.freeze({
            ...options.embedding,
            profile: Object.freeze({ ...options.embedding.profile }),
          })
        : Object.freeze({ ...options.embedding });
    this.#options = { ...options, embedding, rootIds: Object.freeze([...options.rootIds]) };
    this.#deadlines = deadlines;
    this.#entryPath = entryPath;
    this.#lifecycleDelays = lifecycleDelays;
    this.databasePath = options.dbPath;
    this.acquisitionEmbedding = embedding;
    this.rootIds = this.#options.rootIds;
  }

  /**
   * `lifecycleDelays` is Main's E2E seam accessor (`lifecycleDelaySeam`), read at the boundary:
   * `canonical-attach` here and the utility's own `indexer-request`. Absent, nothing is delayed.
   */
  static async create(
    input: unknown,
    deadlineInput: unknown,
    entryPath = resolveBundledSiblingPath('Indexer host', 'indexer-host-entry.js'),
    lifecycleDelays?: () => LifecycleDelaySeam
  ): Promise<IndexerHostManager> {
    const { validateIndexerOptions, validateIndexerDeadlines } = await import(
      '@brainstrike/indexer/transport'
    );
    return new IndexerHostManager(
      validateIndexerOptions(input),
      validateIndexerDeadlines(deadlineInput),
      entryPath,
      lifecycleDelays
    );
  }

  start(): Promise<IndexerPort & ScopedIndexerPort & CoverageAuthorityPort> {
    if (this.#closed) {
      return Promise.reject(new Error('Indexer host is closed; create a fresh owner to restart.'));
    }
    if (!app.isReady()) {
      return Promise.reject(new Error('Indexer utility process requires Electron app readiness.'));
    }
    this.#start ??= this.#launch();
    return this.#start;
  }

  async #launch(): Promise<IndexerPort & ScopedIndexerPort & CoverageAuthorityPort> {
    const { createIndexerConnection } = await import('@brainstrike/indexer/transport');
    // close may race the dynamic import, before any process has been acquired.
    if (this.#closed) {
      throw new Error('Indexer host closed before launch.');
    }
    const child = forkUtility(this.#entryPath, [], {
      env: { ...process.env, ...this.#lifecycleDelays?.().childEnv(['indexer-request']) },
      serviceName: 'brainstrike-indexer',
    });
    this.#kill = () => child.kill();
    const protocolErrors = new Set<(error: unknown) => void>();
    const canonical = new CanonicalUtilityParent(
      (message) => {
        assertCanonicalMessageBound(message);
        child.postMessage(message);
      },
      (error) => {
        this.#closed = true;
        this.#transportFailure = error;
        for (const notify of protocolErrors) {
          notify(error);
        }
      }
    );
    this.#canonical = canonical;
    this.#connection = createIndexerConnection(this.#options, this.#deadlines, {
      kill: () => child.kill(),
      onError: (listener) => {
        protocolErrors.add(listener);
        const error = (type: string, location: string, report: string): void => {
          this.#closed = true;
          listener(new Error(`Indexer utility process ${type} at ${location}: ${report}`));
        };
        child.on('error', error);
        return () => {
          child.off('error', error);
          protocolErrors.delete(listener);
        };
      },
      onExit: (listener) => {
        const exited = (code: number): void => {
          this.#exitCleanup ??= canonical.exited(new IndexerUtilityExitedError());
          void this.#exitCleanup.catch(() => {
            this.#exitCleanupFailed = true;
          });
          listener(code);
        };
        const exit = (code: number): void => {
          this.#closed = true;
          exited(code);
        };
        child.on('exit', exit);
        return () => child.off('exit', exit);
      },
      onKillRefused: (cause) => {
        logger.warn('Indexer utility refused its kill; still joining its exit', { cause });
      },
      onMessage: (listener) => {
        const message = (value: unknown): void => {
          if (!isCanonicalFrame(value)) {
            listener(value);
            return;
          }
          try {
            canonical.receive(value);
          } catch (error) {
            this.#closed = true;
            this.#transportFailure = error;
            for (const notify of protocolErrors) {
              notify(error);
            }
          }
        };
        child.on('message', message);
        return () => child.off('message', message);
      },
      onStall: (stage, elapsedMs) => {
        logger.warn('Indexer utility is slow; still joined, never retired for it', {
          elapsedMs,
          stage,
        });
      },
      send: (message) => child.postMessage(message),
    });
    const port = await this.#connection.ready;
    return { ...port, close: () => this.close(), destroy: () => this.destroy() };
  }

  async attachCanonicalWorkspace(
    dependencies: CanonicalRemoteWorkspaceDependencies
  ): Promise<CanonicalWorkspaceAttachment> {
    const canonical = await this.#admitAttachment();
    return canonical.attachWorkspace(dependencies);
  }

  /** The started utility's canonical channel, refused while closed or while sources retire. */
  async #admitAttachment(): Promise<CanonicalUtilityParent> {
    if (this.#sourceRetirementOwned) {
      throw new Error('Indexer canonical source retirement owns attachment admission.');
    }
    const fences = this.#fences;
    await this.start();
    // E2E seam: the attach boundary as a loaded machine reaches it; admission is checked after.
    await this.#lifecycleDelays?.().delay('canonical-attach');
    this.#refuseFencedAcquisition(fences);
    if (this.#closed || this.#sourceRetirementOwned || !this.#canonical) {
      throw new Error('Indexer canonical attachment admission is closed.');
    }
    return this.#canonical;
  }

  /** Synchronously stops the canonical attachments' admitted requests; see `fenceAttachments`. */
  fenceCanonicalSources(): void {
    this.#fences += 1;
    this.#canonical?.fenceAttachments();
  }

  /**
   * An acquisition that was awaiting start when a fence ran belongs to the graph the fence
   * revoked: refused with that typed retirement before it creates a session (BST-2140). Scoped
   * to that acquisition, not a flag, because sources a later graph admits after the fenced
   * graph's retirement (a reset or root-data deletion reopening) are legitimate.
   */
  #refuseFencedAcquisition(fences: number): void {
    if (fences !== this.#fences) {
      throw new NativeAuthorityTransitionError(
        'Native canonical attachment was fenced during its acquisition.'
      );
    }
  }

  retireCanonicalSources(): Promise<void> {
    this.#sourceRetirementOwned = true;
    const admitted = this.#canonical?.retireAttachments();
    this.#sourceRetirement ??= (async () => {
      // The utility's startup has no deadline (R3), so it is joined outside the close ladder.
      await this.#start;
      await this.#escalated(async () => {
        await (admitted ?? this.#canonical?.retireAttachments());
      });
    })()
      .then(() => {
        this.#sourceRetirementOwned = false;
      })
      .finally(() => {
        this.#sourceRetirement = undefined;
      });
    return this.#sourceRetirement;
  }

  /**
   * R5(b): a cooperative retirement of the utility's attachments that has not finished
   * `closeMs` after it began kills the utility; the work then settles on that exit, which it
   * still joins. A live utility is never refused or abandoned by this clock.
   */
  async #escalated(cooperative: () => Promise<void>): Promise<void> {
    const escalation = setTimeout(() => {
      if (this.#kill === undefined || this.exited) {
        return;
      }
      logger.warn('Indexer utility did not finish its cooperative close; killing it', {
        closeMs: this.#deadlines.closeMs,
      });
      if (!this.#kill()) {
        logger.error('Indexer utility kill was refused; its close still joins its exit', {
          closeMs: this.#deadlines.closeMs,
        });
      }
    }, this.#deadlines.closeMs);
    try {
      await cooperative();
    } finally {
      clearTimeout(escalation);
    }
  }

  get exited(): boolean {
    return this.#connection?.exited ?? false;
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#connection?.exited) {
      if (this.#exitCleanupFailed) {
        this.#exitCleanup = this.#canonical?.close();
        await this.#exitCleanup;
        this.#exitCleanupFailed = false;
      }
      await this.#exitCleanup;
      this.#reportTransportFailure();
      return;
    }
    await this.#escalated(() => this.#canonical?.close() ?? Promise.resolve());
    await this.#connection?.close();
    await this.#exitCleanup;
    this.#reportTransportFailure();
  }

  async destroy(): Promise<void> {
    this.#closed = true;
    if (!this.#connection) {
      throw new Error(
        'Indexer has not acquired a process; destroy requires its validated connection.'
      );
    }
    await this.#escalated(() => this.#canonical?.close() ?? Promise.resolve());
    await this.#connection.destroy();
    await this.#exitCleanup;
    this.#reportTransportFailure();
  }
  #reportTransportFailure(): void {
    if (this.#transportFailure === undefined) {
      return;
    }
    const error = this.#transportFailure;
    this.#transportFailure = undefined;
    throw error;
  }
}
