import { createLogger } from '@brainstrike/utils';
import type { ProfileBootstrapReport } from './bootstrap/profile-bootstrap-report.js';
import type { DbInitializationStatus } from './db-provider.js';

const logger = createLogger('DbProvider');

export interface BrainstrikeSchemaReadyCapabilityInput {
  readonly db: unknown | null;
  readonly error: Error | null;
  readonly initializationStatus: DbInitializationStatus;
  readonly profileBootstrapReport: ProfileBootstrapReport;
  readonly ready: boolean;
}

export function startDbProviderLazyInitialization(initializeDatabase: () => Promise<void>): void {
  initializeDatabase().catch((err) => {
    logger.error({ err }, 'Failed to lazy-initialize database');
  });
}

export function resolveBrainstrikeSchemaReadyCapability(
  input: BrainstrikeSchemaReadyCapabilityInput
): boolean {
  if (input.error) {
    return false;
  }

  const runtimeEngine = input.profileBootstrapReport.runtime.engine;
  if (runtimeEngine === 'pglite') {
    return Boolean(input.ready && input.db);
  }

  if (runtimeEngine === 'turso') {
    return input.initializationStatus === 'ready' && input.profileBootstrapReport.ready === true;
  }

  return false;
}
