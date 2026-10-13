import { mkdir } from 'node:fs/promises';
import { acquireProfileResetLease, type ProfileResetLease } from '@brainstrike/host-lease';

/** Borrows the existing profile retirement owner, then holds its canonical lock through deletion. */
export function createDesktopProfileResetOwner(options: {
  readonly profilePath: () => string;
  readonly retireProfile: () => Promise<void>;
}): {
  prepare(): Promise<ProfileResetLease>;
  clear(lease?: ProfileResetLease): Promise<void>;
} {
  let preparing: Promise<ProfileResetLease> | undefined;
  let current: ProfileResetLease | undefined;
  const prepare = (): Promise<ProfileResetLease> => {
    if (current && !current.isReleased) {
      return Promise.resolve(current);
    }
    preparing ??= (async () => {
      await options.retireProfile();
      const root = options.profilePath();
      await mkdir(root, { recursive: true });
      current = await acquireProfileResetLease(root);
      return current;
    })().finally(() => {
      preparing = undefined;
    });
    return preparing;
  };
  return {
    clear: async (lease) => {
      if (!lease || lease !== current || lease.isReleased) {
        throw new Error('Profile reset requires its active owned lease');
      }
      await lease.clearRootContents();
    },
    prepare,
  };
}
