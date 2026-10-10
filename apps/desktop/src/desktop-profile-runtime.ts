interface ProfileOwner<Attachment> {
  acquire(): Promise<Attachment>;
  close(): Promise<void>;
}

export interface DesktopProfileRuntime<Attachment> {
  acquire(): Promise<Attachment>;
  isRetiring(): boolean;
  retire(beforeClose?: Promise<void>): Promise<void>;
  retireFailed(): Promise<boolean>;
}

/** One Main-owned profile lease, shared by bootstrap, clients and native indexing. */
export function createDesktopProfileRuntime<Attachment>(
  createOwner: () => ProfileOwner<Attachment>
): DesktopProfileRuntime<Attachment> {
  let owner: ProfileOwner<Attachment> | undefined;
  let acquisition: Promise<Attachment> | undefined;
  let retirement: Promise<void> | undefined;
  let retirementPending = false;
  let failedOwner: ProfileOwner<Attachment> | undefined;

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
  return {
    acquire: async () => {
      await retirement;
      owner ??= createOwner();
      const retained = owner;
      acquisition ??= retained.acquire();
      const acquiring = acquisition;
      try {
        return await acquiring;
      } catch (cause) {
        if (acquisition === acquiring && !retirement) {
          failedOwner = retained;
          owner = undefined;
          acquisition = undefined;
        }
        throw cause;
      }
    },
    isRetiring: () => retirement !== undefined,
    retire: (beforeClose = Promise.resolve()) => {
      if (retirement && retirementPending) {
        return retirement;
      }
      retirementPending = true;
      const retiring = (async (): Promise<void> => {
        await beforeClose;
        await retireFailed();
        // Startup may still await Main's binding. Close aborts startup; join both
        // tails before allowing reset to create the next profile owner.
        const [closed] = await Promise.allSettled([owner?.close(), acquisition]);
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
