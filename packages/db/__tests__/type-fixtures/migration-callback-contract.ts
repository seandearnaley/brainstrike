import type { Migration } from '../../src/migrations/migration-runner.js';

export const migrationCallbackContractFixture: Migration = {
  down: async (db) => {
    await db.exec('SELECT 1;');

    // @ts-expect-error Migration callbacks do not receive lifecycle methods from PGlite.
    await db.close();
  },
  name: 'migration_callback_contract_fixture',
  up: async (db) => {
    await db.exec('SELECT 1;');
    await db.query('SELECT 1;');

    // @ts-expect-error Migration callbacks receive the transactional DB interface only.
    await db.transaction(async () => undefined);
  },
  version: 48_800,
};
