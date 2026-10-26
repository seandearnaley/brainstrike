import type { ClearContentResult } from '@brainstrike/state-store';

interface ProfileOwner<Attachment> {
  acquire(): Promise<Attachment>;
  clearAndRetireContent?(): Promise<ClearContentResult>;
  close(reason?: unknown): Promise<void>;
}

export interface DesktopProfileRuntime<Attachment> {
  acquire(signal?: AbortSignal): Promise<Attachment>;
  clearAndRetireContent(): Promise<ClearContentResult>;
  isRetiring(): boolean;
  /** Why the profile's last host start failed, until a start succeeds. */
  lastFailure(): { readonly cause: unknown } | undefined;
  /** Closes the current host at once; `beside` runs alongside that close and is joined. */
  retire(beside?: Promise<void>, reason?: unknown): Promise<void>;
  retireFailed(): Promise<boolean>;
}

/**
 * One Main-owned profile lease, shared by bootstrap, clients and native indexing.
 * `createOwner` receives `lost`, which the owner calls when its ready host exits
 * without Main asking (BST-2004). That owner then fails like a failed start:
 * `retireFailed` joins its release before admission starts the next host. An
 * intended retirement closes its own owner and never takes that path.
 */
export function createDesktopProfileRuntime<Attachment>(
  createOwner: (lost: () => void) => ProfileOwner<Attachment>
): DesktopProfileRuntime<Attachment> {
  let owner: ProfileOwner<Attachment> | undefined;
  let acquisition: Promise<Attachment> | undefined;
  let retirement: Promise<void> | undefined;
  let retirementPending = false;
  let failedOwner: ProfileOwner<Attachment> | undefined;
  let lastFailure: { readonly cause: unknown } | undefined;

  const retireFailed = async (): Promise<boolean> => {
    const failed = failedOwner;
    if (!failed) {
      return false;
    }
    await failed.close();
    if (failedOwner === failed) {
      failedOwner = undefined;
    }
    return true;
  };
  const create = (): ProfileOwner<Attachment> => {
    const created: ProfileOwner<Attachment> = createOwner(() => {
      // An intended retirement closes its own owner, from the moment it is asked for.
      if (retirementPending || retirement || owner !== created) {
        return;
      }
      failedOwner = created;
      owner = undefined;
      acquisition = undefined;
    });
    return created;
  };
  return {
    acquire: async (signal) => {
      // A retirement that begins while this acquisition yields ends before any owner starts:
      // no host ever starts under a retirement.
      do {
        await retirement;
      } while (retirement);
      signal?.throwIfAborted();
      if (!owner && failedOwner) {
        // A failed start answers at once while its release goes on; the next owner starts
        // against the Root only once that release has ended.
        await retireFailed();
        // A retirement that began during that release ends before any next owner starts.
        await retirement;
        signal?.throwIfAborted();
      }
      owner ??= create();
      const retained = owner;
      acquisition ??= retained.acquire();
      const acquiring = acquisition;
      try {
        const attachment = await acquiring;
        lastFailure = undefined;
        return attachment;
      } catch (cause) {
        if (acquisition === acquiring && !retirement) {
          failedOwner = retained;
          lastFailure = { cause };
          owner = undefined;
          acquisition = undefined;
        }
        throw cause;
      }
    },
    clearAndRetireContent: () => {
      if (retirement) {
        return Promise.reject(new Error('Profile retirement is already in progress'));
      }
      retirementPending = true;
      const clearing = (async (): Promise<ClearContentResult> => {
        await retireFailed();
        owner ??= create();
        const retained = owner;
        acquisition ??= retained.acquire();
        await acquisition;
        if (!retained.clearAndRetireContent) {
          throw new Error('This profile owner cannot clear content');
        }
        const result = await retained.clearAndRetireContent();
        owner = undefined;
        acquisition = undefined;
        return result;
      })();
      retirement = clearing.then(() => undefined);
      retirement.catch(() => undefined);
      return clearing.then(
        (result) => {
          retirementPending = false;
          retirement = undefined;
          return result;
        },
        (cause: unknown) => {
          retirementPending = false;
          throw cause;
        }
      );
    },
    isRetiring: () => retirement !== undefined,
    lastFailure: () => lastFailure,
    retire: (beside = Promise.resolve(), reason?: unknown) => {
      if (retirement && retirementPending) {
        // A retirement already in flight closes the host; this caller's own work still reports.
        return Promise.all([retirement, beside]).then(() => undefined);
      }
      retirementPending = true;
      const retiring = (async (): Promise<void> => {
        // ADR-0031: the host's close (stdin end, 5 s, kill) starts now. `beside` (the index
        // close) and a failed owner's release run alongside it, never in front of it. The
        // owner's close ends a startup in flight; nothing waits on that startup itself.
        const [closed, besideSettled, failedSettled] = await Promise.allSettled([
          owner?.close(reason),
          beside,
          retireFailed(),
        ]);
        if (closed.status === 'fulfilled') {
          owner = undefined;
          acquisition = undefined;
        }
        const failures = [closed, besideSettled, failedSettled].flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        );
        if (failures.length > 1) {
          throw new AggregateError(failures, 'Profile retirement failed');
        }
        if (failures.length === 1) {
          throw failures[0];
        }
      })();
      retirement = retiring;
      return retiring.then(
        () => {
          retirementPending = false;
          retirement = undefined;
        },
        (cause: unknown) => {
          retirementPending = false;
          throw cause;
        }
      );
    },
    retireFailed,
  };
}
