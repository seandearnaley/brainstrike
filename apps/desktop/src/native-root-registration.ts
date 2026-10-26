import type { IndexRootRegistrationCapability } from '@brainstrike/indexing-contract/indexer-client';
import { NativeAuthorityTransitionError } from './native-authority-transition';
import { NativeIndexSetupRequiredError } from './native-index-setup-required';

interface Dependencies {
  isShuttingDown(): boolean;
  reconfigureRoots(): Promise<void>;
  reportError(message: string, error: unknown): void;
  transition(operation: () => Promise<void>): Promise<void>;
}

/**
 * Re-read committed roots through the existing Main-owned, joined transition. A quit leaves
 * nothing to do: the roots are committed, and the next start's activation reads them.
 */
export function createNativeRootRegistration(
  dependencies: Dependencies
): IndexRootRegistrationCapability {
  return {
    rootsRegistered: async () => {
      try {
        await dependencies.transition(async () => {
          if (!dependencies.isShuttingDown()) {
            await dependencies.reconfigureRoots();
          }
        });
      } catch (error) {
        if (error instanceof NativeAuthorityTransitionError && dependencies.isShuttingDown()) {
          // The quit retired the index while this registration waited on it.
          return;
        }
        dependencies.reportError(
          'Registered native source configuration could not activate',
          error
        );
        if (error instanceof NativeIndexSetupRequiredError) {
          // Re-evaluation completed with a retained actionable setup requirement.
          return;
        }
        throw error;
      }
    },
  };
}
