import { runAtPromiseBoundary } from '@brainstrike/effect-kit';
import { Deferred, Effect, Exit, Scope, Semaphore, Stream, SubscriptionRef } from 'effect';

export interface ChildGenerationContext {
  readonly generation: number;
  lost(cause: unknown): Promise<void>;
  readonly signal: AbortSignal;
}
export interface ChildResource<Client> {
  /** Joins physical exit/closed and all borrowed-resource cleanup; failure retains ownership. */
  close(reason: unknown): Promise<void>;
  readonly ready: Promise<Client>;
}
export type ChildState<Client> =
  | { readonly kind: 'idle' | 'starting' | 'restarting' | 'stopping' }
  | { readonly kind: 'ready'; readonly client: Client }
  | { readonly kind: 'lost' | 'failed' | 'stopped'; readonly cause: unknown };
export type ChildSnapshot<Client> = ChildState<Client> & { readonly generation: number };
export interface ChildSupervisor<Client> {
  acquire(): Promise<Client>;
  observe(listener: (state: ChildSnapshot<Client>) => void, signal: AbortSignal): Promise<void>;
  /** Explicit user action only. Passive demand and replacement callbacks must use acquire. */
  restart(options?: { readonly onlyFailed: true }): Promise<Client>;
  retireLost(): Promise<boolean>;
  snapshot(): Promise<ChildSnapshot<Client>>;
  stop(reason?: unknown): Promise<void>;
}
interface OwnedGeneration<Client> {
  readonly abort: AbortController;
  readonly generation: number;
  readonly ready: Deferred.Deferred<Client, unknown>;
  /** Physical release join; failed release remains retryable, never a lifecycle flag. */
  release?: Promise<void> | undefined;
  resource?: ChildResource<Client>;
  readonly scope: Scope.Closeable;
}
interface State<Client> {
  readonly automaticSpent: boolean;
  readonly owned?: OwnedGeneration<Client>;
  readonly snapshot: ChildSnapshot<Client>;
  readonly waiting?: Deferred.Deferred<Client, unknown>;
}
interface Options<Client> {
  create(context: ChildGenerationContext): ChildResource<Client>;
  readonly restart: 'lazy' | 'immediate' | 'never';
}

/** One Main owner for process admission and replacement; adapters own their physical protocol. */
export async function createChildSupervisor<Client>(
  options: Options<Client>
): Promise<ChildSupervisor<Client>> {
  const state = await runAtPromiseBoundary(
    SubscriptionRef.make<State<Client>>({
      automaticSpent: false,
      snapshot: { generation: 0, kind: 'idle' },
    })
  );
  const permit = Semaphore.makeUnsafe(1);
  const locked = <A>(work: Effect.Effect<A, unknown>): Promise<A> =>
    runAtPromiseBoundary(permit.withPermit(work));
  const publish = (next: State<Client>): Effect.Effect<void> => SubscriptionRef.set(state, next);
  const read = (): Promise<State<Client>> => runAtPromiseBoundary(SubscriptionRef.get(state));

  const release = (owned: OwnedGeneration<Client>, reason: unknown): Promise<void> => {
    owned.abort.abort(reason);
    if (!owned.release) {
      const closing = owned.resource?.close(reason) ?? Promise.resolve();
      owned.release = closing;
      void closing.catch(() => {
        if (owned.release === closing) {
          owned.release = undefined;
        }
      });
    }
    return owned.release;
  };
  const close = async (owned: OwnedGeneration<Client>, reason: unknown): Promise<void> => {
    // A failed physical close stays retryable. Close the Scope only after that
    // join succeeds; its finalizer shares the same fulfilled release promise.
    await release(owned, reason);
    await runAtPromiseBoundary(Scope.close(owned.scope, Exit.void));
  };
  const settleFailure = async (owned: OwnedGeneration<Client>, cause: unknown): Promise<void> => {
    await locked(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        yield* Deferred.fail(owned.ready, cause);
        if (current.owned !== owned || current.snapshot.kind === 'stopping') {
          return;
        }
        if (current.waiting) {
          yield* Deferred.fail(current.waiting, cause);
        }
        yield* publish({
          ...current,
          snapshot: { cause, generation: owned.generation, kind: 'failed' },
        });
      })
    );
  };
  const ready = async (owned: OwnedGeneration<Client>, work: Promise<Client>): Promise<void> => {
    try {
      const client = await work;
      await locked(
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state);
          if (
            current.owned !== owned ||
            (current.snapshot.kind !== 'starting' && current.snapshot.kind !== 'restarting')
          ) {
            return;
          }
          yield* publish({
            ...current,
            snapshot: { client, generation: owned.generation, kind: 'ready' },
          });
          yield* Deferred.succeed(owned.ready, client);
        })
      );
    } catch (cause) {
      // Physical startup can fail independently while a stop is joining it.
      // Preserve that original result even when lifecycle admission is fenced.
      if (owned.abort.signal.aborted) {
        await runAtPromiseBoundary(Deferred.fail(owned.ready, cause));
      } else {
        await settleFailure(owned, cause);
      }
    }
  };
  const begin = Effect.fnUntraced(function* (
    current: State<Client>,
    automaticSpent: boolean,
    restarting: boolean,
    waiting?: Deferred.Deferred<Client, unknown>
  ): Effect.fn.Return<OwnedGeneration<Client>, unknown> {
    const owned: OwnedGeneration<Client> = {
      abort: new AbortController(),
      generation: current.snapshot.generation + 1,
      ready: waiting ?? Deferred.makeUnsafe<Client, unknown>(),
      scope: Scope.makeUnsafe(),
    };
    yield* publish({
      automaticSpent,
      owned,
      snapshot: { generation: owned.generation, kind: restarting ? 'restarting' : 'starting' },
      waiting: owned.ready,
    });
    yield* Effect.acquireRelease(
      Effect.try({
        catch: (cause) => cause,
        try: () =>
          options.create({
            generation: owned.generation,
            lost: (cause) => lost(owned, cause),
            signal: owned.abort.signal,
          }),
      }),
      () => Effect.promise(() => release(owned, owned.abort.signal.reason))
    ).pipe(
      Scope.provide(owned.scope),
      Effect.tap((resource) =>
        Effect.sync(() => {
          owned.resource = resource;
          // Observe rejection immediately, after publishing this generation.
          void ready(owned, resource.ready);
        })
      ),
      Effect.catch((cause) =>
        Effect.gen(function* () {
          yield* Deferred.fail(owned.ready, cause);
          yield* publish({
            automaticSpent,
            owned,
            snapshot: { cause, generation: owned.generation, kind: 'failed' },
            waiting: owned.ready,
          });
        })
      )
    );
    return owned;
  });
  const awaitReady = (owned: OwnedGeneration<Client>): Promise<Client> =>
    runAtPromiseBoundary(Deferred.await(owned.ready));

  const replace = async (
    previous: OwnedGeneration<Client>,
    reason: unknown,
    explicit: boolean
  ): Promise<Client> => {
    try {
      await close(previous, reason);
    } catch (cause) {
      await settleFailure(previous, cause);
      throw cause;
    }
    const next = await locked(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        // Stop or another explicit action supersedes this recovery while physical cleanup joins.
        if (current.owned !== previous || current.snapshot.kind !== 'restarting') {
          return yield* Effect.fail('cause' in current.snapshot ? current.snapshot.cause : reason);
        }
        return yield* begin(current, !explicit, true, current.waiting);
      })
    );
    return awaitReady(next);
  };
  const lost = async (owned: OwnedGeneration<Client>, cause: unknown): Promise<void> => {
    const replacement = await locked(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        if (
          current.owned !== owned ||
          owned.abort.signal.aborted ||
          (current.snapshot.kind !== 'ready' &&
            current.snapshot.kind !== 'starting' &&
            current.snapshot.kind !== 'restarting')
        ) {
          return false;
        }
        owned.abort.abort(cause);
        yield* Deferred.fail(owned.ready, cause);
        const retry = !current.automaticSpent && options.restart !== 'never';
        yield* publish({
          ...current,
          snapshot: { cause, generation: owned.generation, kind: retry ? 'lost' : 'failed' },
        });
        if (!retry || options.restart !== 'immediate') {
          return false;
        }
        yield* publish({
          ...current,
          automaticSpent: true,
          snapshot: { generation: owned.generation, kind: 'restarting' },
          waiting: Deferred.makeUnsafe<Client, unknown>(),
        });
        return true;
      })
    );
    if (replacement) {
      await replace(owned, cause, false);
    }
  };
  const acquire = async (): Promise<Client> => {
    const admission = await locked(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        switch (current.snapshot.kind) {
          case 'ready':
            return { client: current.snapshot.client, kind: 'client' as const };
          case 'idle':
            return { kind: 'wait' as const, waiting: (yield* begin(current, false, false)).ready };
          case 'starting':
          case 'restarting':
            if (current.owned) {
              return { kind: 'wait' as const, waiting: current.waiting ?? current.owned.ready };
            }
            return yield* Effect.fail(new Error('Child startup has no owned generation'));
          case 'lost': {
            if (!current.owned) {
              return { kind: 'wait' as const, waiting: (yield* begin(current, true, true)).ready };
            }
            yield* publish({
              ...current,
              automaticSpent: true,
              snapshot: { generation: current.snapshot.generation, kind: 'restarting' },
              waiting: Deferred.makeUnsafe<Client, unknown>(),
            });
            return {
              cause: current.snapshot.cause,
              kind: 'replace' as const,
              owned: current.owned,
            };
          }
          case 'failed':
          case 'stopped':
            return yield* Effect.fail(current.snapshot.cause);
          case 'stopping':
            return yield* Effect.fail(current.owned?.abort.signal.reason);
        }
      })
    );
    if (admission.kind === 'client') {
      return admission.client;
    }
    if (admission.kind === 'replace') {
      return replace(admission.owned, admission.cause, false);
    }
    return runAtPromiseBoundary(Deferred.await(admission.waiting));
  };
  const stop = async (reason: unknown = new Error('Child stopped')): Promise<void> => {
    const owned = await locked(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        current.owned?.abort.abort(reason);
        yield* publish({
          ...current,
          snapshot: { generation: current.snapshot.generation, kind: 'stopping' },
        });
        return current.owned;
      })
    );
    try {
      if (owned) {
        await close(owned, reason);
      }
    } catch (cause) {
      await locked(
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state);
          if (current.owned === owned) {
            if (owned) {
              yield* Deferred.fail(current.waiting ?? owned.ready, cause);
            }
            yield* publish({
              ...current,
              snapshot: { cause, generation: current.snapshot.generation, kind: 'failed' },
            });
          }
        })
      );
      throw cause;
    }
    await locked(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        if (current.owned === owned && current.snapshot.kind === 'stopping') {
          if (owned) {
            yield* Deferred.fail(current.waiting ?? owned.ready, reason);
          }
          yield* publish({
            automaticSpent: current.automaticSpent,
            snapshot: { cause: reason, generation: current.snapshot.generation, kind: 'stopped' },
          });
        }
      })
    );
  };
  return {
    acquire,
    observe: (listener, signal) =>
      runAtPromiseBoundary(
        SubscriptionRef.changes(state).pipe(
          Stream.interruptWhen(
            Effect.callback<never, unknown>((resume) => {
              const abort = (): void => resume(Effect.fail(signal.reason));
              signal.addEventListener('abort', abort, { once: true });
              if (signal.aborted) {
                abort();
              }
              return Effect.sync(() => signal.removeEventListener('abort', abort));
            })
          ),
          Stream.runForEach((value) => Effect.sync(() => listener(value.snapshot)))
        )
      ),
    restart: async (options) => {
      const reason = new Error('Explicit child restart');
      const admission = await locked(
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state);
          if (options?.onlyFailed && current.snapshot.kind === 'ready') {
            return { client: current.snapshot.client, kind: 'client' as const };
          }
          if (
            (current.snapshot.kind === 'restarting' ||
              (options?.onlyFailed && current.snapshot.kind === 'starting')) &&
            current.waiting
          ) {
            return { kind: 'wait' as const, waiting: current.waiting };
          }
          if (current.snapshot.kind === 'stopping') {
            return yield* Effect.fail(current.owned?.abort.signal.reason);
          }
          if (!current.owned) {
            return { kind: 'wait' as const, waiting: (yield* begin(current, false, false)).ready };
          }
          current.owned.abort.abort(reason);
          yield* Deferred.fail(current.waiting ?? current.owned.ready, reason);
          yield* publish({
            ...current,
            automaticSpent: false,
            snapshot: { generation: current.snapshot.generation, kind: 'restarting' },
            waiting: Deferred.makeUnsafe<Client, unknown>(),
          });
          return { kind: 'replace' as const, owned: current.owned };
        })
      );
      if (admission.kind === 'client') {
        return admission.client;
      }
      return admission.kind === 'replace'
        ? replace(admission.owned, reason, true)
        : runAtPromiseBoundary(Deferred.await(admission.waiting));
    },
    retireLost: async () => {
      const captured = await read();
      if (
        !captured.owned ||
        (captured.snapshot.kind !== 'lost' && captured.snapshot.kind !== 'failed')
      ) {
        return false;
      }
      await close(captured.owned, captured.snapshot.cause);
      return locked(
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state);
          if (current.owned !== captured.owned || current.snapshot !== captured.snapshot) {
            return false;
          }
          yield* publish({ automaticSpent: current.automaticSpent, snapshot: current.snapshot });
          return true;
        })
      );
    },
    snapshot: async () => (await read()).snapshot,
    stop,
  };
}
