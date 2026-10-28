import { NativeIndexSetupRequiredError } from '@brainstrike/assistant-service/node-native-text-services';
import type { IndexRootRegistrationCapability } from '@brainstrike/indexing-contract/indexer-client';
import { NativeAuthorityTransitionError } from './native-authority-transition';

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
  // Each re-read reopens the index, and one folder change can notify several times. A re-read
  // that started after a notification read what it announced, so that notification adds none.
  let rereads = 0;
  return {
    rootsRegistered: async () => {
      const announced = rereads;
      try {
        await dependencies.transition(async () => {
          if (dependencies.isShuttingDown()) {
            throw new NativeAuthorityTransitionError(
              'Native root registration retired during shutdown.'
            );
          }
          if (rereads > announced) {
            return;
          }
          rereads += 1;
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
