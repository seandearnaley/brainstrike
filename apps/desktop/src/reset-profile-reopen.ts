/**
 * ADR-0015: a factory reset reopens the fresh profile only after the replacement renderer
 * reports ready. From data deletion until that reopen, work that needs the profile's catalog
 * waits here instead of reaching the closed profile.
 */
export interface ResetProfileReopen {
  /** Data deletion closed the profile; `whenOpen` waits from now until `release`. */
  readonly hold: () => void;
  /** The reset reopened the profile, or, given a cause, ended without reopening it. */
  readonly release: (notReopened?: unknown) => void;
  /** Resolves at once unless a reset holds the profile closed. */
  readonly whenOpen: () => Promise<void>;
}

export function createResetProfileReopen(): ResetProfileReopen {
  let held: PromiseWithResolvers<void> | undefined;
  return {
    hold: () => {
      if (held) {
        return;
      }
      held = Promise.withResolvers<void>();
      // A reset nobody waited on must not surface as an unhandled rejection.
      held.promise.catch(() => undefined);
    },
    release: (notReopened) => {
      const current = held;
      held = undefined;
      if (notReopened === undefined) {
        current?.resolve();
      } else {
        current?.reject(notReopened);
      }
    },
    whenOpen: () => held?.promise ?? Promise.resolve(),
  };
}
