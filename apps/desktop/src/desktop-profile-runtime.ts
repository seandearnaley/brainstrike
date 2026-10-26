import type { ClearContentResult } from '@brainstrike/state-store';

interface ProfileOwner<Attachment> {
  acquire(): Promise<Attachment>;
  clearAndRetireContent?(): Promise<ClearContentResult>;
  close(reason?: unknown): Promise<void>;
  /** The exit of this owner's ready host, once it has one. */
  hostExited?(): Promise<unknown> | undefined;
  /** Why this owner's start failed, known before its release ends. */
  startFailure?(): { readonly cause: unknown } | undefined;
}

export interface DesktopProfileRuntime<Attachment> {
  acquire(signal?: AbortSignal): Promise<Attachment>;
  clearAndRetireContent(): Promise<ClearContentResult>;
  /** The exit of the current owner's ready host, once it has one. */
  hostExited(): Promise<unknown> | undefined;
  isRetiring(): boolean;
  /** Why the profile's last host start failed, until a start succeeds. */
  lastFailure(): { readonly cause: unknown } | undefined;
  retire(beforeClose?: Promise<void>, reason?: unknown): Promise<void>;
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
      if (retirement || owner !== created) {
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
      await retirement;
      signal?.throwIfAborted();
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
    hostExited: () => owner?.hostExited?.(),
    isRetiring: () => retirement !== undefined,
    // A start that failed is known to its owner before its release ends and the acquisition settles.
    lastFailure: () => lastFailure ?? owner?.startFailure?.(),
    retire: (beforeClose = Promise.resolve(), reason?: unknown) => {
      if (retirement && retirementPending) {
        return retirement;
      }
      retirementPending = true;
      const retiring = (async (): Promise<void> => {
        await beforeClose;
        await retireFailed();
        // Startup may still await Main's binding. Close aborts startup; join both
        // tails before allowing reset to create the next profile owner.
        const [closed] = await Promise.allSettled([owner?.close(reason), acquisition]);
        if (closed?.status === 'rejected') {
          throw closed.reason;
        }
        owner = undefined;
        acquisition = undefined;
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
