import type { IndexRootRegistrationCapability } from '@brainstrike/indexing-contract/indexer-client';
import { NativeAuthorityTransitionError } from './native-authority-transition';
import { NativeIndexSetupRequiredError } from './native-index-setup-required';

interface Dependencies {
  isShuttingDown(): boolean;
  reconfigureRoots(): Promise<void>;
  reportError(message: string, error: unknown): void;
  transition(operation: () => Promise<void>): Promise<void>;
}

/** Re-read committed roots through the existing Main-owned, joined transition. */
export function createNativeRootRegistration(
  dependencies: Dependencies
): IndexRootRegistrationCapability {
  return {
    rootsRegistered: async () => {
      try {
        await dependencies.transition(async () => {
          if (dependencies.isShuttingDown()) {
            throw new NativeAuthorityTransitionError(
              'Native root registration retired during shutdown.'
            );
          }
          await dependencies.reconfigureRoots();
        });
      } catch (error) {
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
