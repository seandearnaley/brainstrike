import { runAtPromiseBoundary } from '@brainstrike/effect-kit';
import { Data, Effect, Exit, Scope } from 'effect';

class ResourceFailure extends Data.TaggedError('HostResourceFailure')<{
  readonly cause: unknown;
}> {}
const resourceFailure = (cause: unknown): ResourceFailure => new ResourceFailure({ cause });

/** A Promise-facing owner whose Effect Scope joins all acquired resource releases. */
export class ResourceOwner {
  private readonly scope = Scope.makeUnsafe();
  private closing: Promise<void> | undefined;

  acquire<T>(acquire: () => Promise<T>, release: (value: T) => Promise<void>): Promise<T> {
    if (this.closing) {
      return Promise.reject(new Error('Host resource owner is closing'));
    }
    return runAtPromiseBoundary(
      Effect.acquireRelease(
        Effect.tryPromise({ catch: resourceFailure, try: acquire }).pipe(
          Effect.catchTag('HostResourceFailure', (failure) => Effect.die(failure.cause))
        ),
        (value) =>
          Effect.tryPromise({ catch: resourceFailure, try: () => release(value) }).pipe(
            Effect.catchTag('HostResourceFailure', (failure) => Effect.die(failure.cause))
          )
      ).pipe(Scope.provide(this.scope))
    );
  }

  close(): Promise<void> {
    this.closing ??= runAtPromiseBoundary(Scope.close(this.scope, Exit.void));
    return this.closing;
  }
}
