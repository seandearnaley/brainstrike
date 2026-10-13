import { BoundaryFailureError, processLost } from '@brainstrike/assistant-contract';
import { OwnedHostStartError } from '@brainstrike/host-lease';
import { createLogger } from '@brainstrike/logging';
import { createChildSupervisor } from './child-supervisor';

const logger = createLogger('DesktopProfileRuntime');

interface ProfileOwner<Attachment> {
  acquire(): Promise<Attachment>;
  close(reason?: unknown): Promise<void>;
}

export interface DesktopProfileRuntime<Attachment> {
  acquire(signal?: AbortSignal): Promise<Attachment>;
  isRetiring(): boolean;
  reconnect(): Promise<Attachment>;
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
  // This barrier owns the profile transaction's before-close dependency, not
  // child readiness or replacement. ChildSupervisor alone owns those facts.
  let retirement: Promise<void> | undefined;
  let retirementPending = false;
  const supervisor = createChildSupervisor<Attachment>({
    create: (context) => {
      const owner = createOwner(() => {
        const cause = new BoundaryFailureError(processLost({ child: 'agent-host' }));
        void context.lost(cause).catch((error: unknown) => {
          logger.error('Agent host loss cleanup failed', { error });
        });
      });
      return {
        close: (reason) => owner.close(reason),
        ready: owner.acquire().catch(async (cause: unknown) => {
          // The actual child exit/deadline producer establishes restartability.
          // Refused external leases and independent failures never spend a retry.
          if (cause instanceof OwnedHostStartError) {
            await context.lost(cause);
          }
          throw cause;
        }),
      };
    },
    restart: 'lazy',
  });
  const retireFailed = async (): Promise<boolean> => (await supervisor).retireLost();
  return {
    acquire: async (signal) => {
      await retirement;
      signal?.throwIfAborted();
      const child = await supervisor;
      // A deliberate profile retirement (reset) has already joined its barrier.
      // Reopening after that action starts a new user generation.
      return (await child.snapshot()).kind === 'stopped' ? child.restart() : child.acquire();
    },
    isRetiring: () => retirement !== undefined,
    reconnect: async () => {
      await retirement;
      return (await supervisor).restart({ onlyFailed: true });
    },
    retire: (beforeClose = Promise.resolve(), reason?: unknown) => {
      if (retirement && retirementPending) {
        return retirement;
      }
      retirementPending = true;
      const retiring = (async (): Promise<void> => {
        await beforeClose;
        await (await supervisor).stop(reason);
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
