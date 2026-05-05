import { createLogger } from '@brainstrike/utils';
import type { PGlite } from '@electric-sql/pglite';

export type MigrationTransactionalDb = Pick<PGlite, 'exec' | 'query'>;
export type MigrationCallback = (db: MigrationTransactionalDb) => Promise<void>;

export interface Migration {
  down?: string | MigrationCallback;
  name: string;
  up: string | MigrationCallback;
  version: number;
}

export class MigrationRunner {
  private static MIGRATION_TABLE = '_migrations';
  private readonly logger = createLogger('MigrationRunner');

  constructor(private readonly db: PGlite) {}

  private static isTransactionalDb(db: PGlite): db is PGlite & {
    transaction: (fn: (tx: MigrationTransactionalDb) => Promise<void>) => Promise<void>;
  } {
    // Narrow the type by checking the transaction function at runtime
    return typeof (db as unknown as { transaction?: unknown }).transaction === 'function';
  }

  /**
   * Initialize migration tracking table
   */
  async initialize(): Promise<void> {
    await this.db.exec(`
			CREATE TABLE IF NOT EXISTS ${MigrationRunner.MIGRATION_TABLE} (
				version INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				checksum TEXT NOT NULL
			);
		`);
  }

  /**
   * Get list of applied migrations
   */
  async getAppliedMigrations(): Promise<number[]> {
    const result = await this.db.query<{ version: number }>(
      `SELECT version FROM ${MigrationRunner.MIGRATION_TABLE} ORDER BY version`
    );
    return result.rows.map((row) => row.version);
  }

  /**
   * Check if a migration has been applied
   */
  async isApplied(version: number): Promise<boolean> {
    const result = await this.db.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM ${MigrationRunner.MIGRATION_TABLE} WHERE version = $1`,
      [version]
    );
    return (result.rows[0]?.count ?? 0) > 0;
  }

  /**
   * Calculate cryptographic checksum for migration content
   */
  private calculateChecksum(content: string): string {
    // Use a simple but effective hash for migration verification
    // This is platform-agnostic and doesn't require Node.js crypto module
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash &= hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(16);
  }

  /**
   * Run a single migration
   */
  async runMigration(migration: Migration): Promise<void> {
    const hasTx = MigrationRunner.isTransactionalDb(this.db);
    const execWith = async (dbi: MigrationTransactionalDb) => {
      const appliedResult = await dbi.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${MigrationRunner.MIGRATION_TABLE} WHERE version = $1`,
        [migration.version]
      );
      const appliedCount = Number(appliedResult.rows[0]?.count ?? 0);
      if (appliedCount > 0) {
        this.logger.info('Migration already applied, skipping', { version: migration.version });
        return;
      }
      // Execute migration based on type
      if (typeof migration.up === 'string') {
        await dbi.exec(migration.up);
      } else {
        // Run function-style migration against the transactional interface
        await migration.up(dbi);
      }
      const checksum = this.calculateChecksum(
        typeof migration.up === 'string' ? migration.up : migration.name
      );
      await dbi.query(
        `INSERT INTO ${MigrationRunner.MIGRATION_TABLE} (version, name, checksum) VALUES ($1, $2, $3)`,
        [migration.version, migration.name, checksum]
      );
    };

    if (hasTx) {
      await this.db.transaction(async (tx: MigrationTransactionalDb) => {
        try {
          await execWith(tx);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          throw new Error(`Migration ${migration.version} failed: ${errorMessage}`);
        }
      });
      return;
    }

    // Use local reference to avoid TypeScript narrowing this.db to never
    const db = this.db as PGlite;
    try {
      await db.exec('BEGIN');
      await execWith(db);
      await db.exec('COMMIT');
    } catch (error) {
      await db.exec('ROLLBACK');
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Migration ${migration.version} failed: ${errorMessage}`);
    }
  }

  /**
   * Run all pending migrations
   * Optimized: batch-fetches applied versions upfront to avoid N individual queries
   */
  async up(migrations: Migration[]): Promise<void> {
    // Sort migrations by version
    const sortedMigrations = [...migrations].sort((a, b) => a.version - b.version);

    // Batch-fetch all applied migrations upfront (single query instead of N queries)
    const appliedVersions = new Set(await this.getAppliedMigrations());
    let cachedSkippedCount = 0;
    let firstCachedSkippedVersion: number | null = null;
    let lastCachedSkippedVersion: number | null = null;

    for (const migration of sortedMigrations) {
      // Skip already-applied migrations without hitting the database
      if (appliedVersions.has(migration.version)) {
        cachedSkippedCount += 1;
        if (firstCachedSkippedVersion === null) {
          firstCachedSkippedVersion = migration.version;
        }
        lastCachedSkippedVersion = migration.version;
        continue;
      }
      await this.runMigration(migration);
    }

    if (cachedSkippedCount > 0) {
      this.logger.debug('Skipped already applied migrations from cache', {
        count: cachedSkippedCount,
        firstVersion: firstCachedSkippedVersion,
        lastVersion: lastCachedSkippedVersion,
      });
    }
  }

  /**
   * Rollback a specific migration
   */
  async rollback(migration: Migration): Promise<void> {
    if (!migration.down) {
      throw new Error(`Migration ${migration.version} does not support rollback`);
    }

    const hasTx = MigrationRunner.isTransactionalDb(this.db);
    const downMigration = migration.down;
    const execWith = async (dbi: MigrationTransactionalDb) => {
      const appliedResult = await dbi.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${MigrationRunner.MIGRATION_TABLE} WHERE version = $1`,
        [migration.version]
      );
      const appliedCount = Number(appliedResult.rows[0]?.count ?? 0);
      if (appliedCount === 0) {
        this.logger.info('Migration not applied, skipping rollback', {
          version: migration.version,
        });
        return;
      }

      if (typeof downMigration === 'string') {
        await dbi.exec(downMigration);
      } else {
        await downMigration(dbi);
      }
      await dbi.query(`DELETE FROM ${MigrationRunner.MIGRATION_TABLE} WHERE version = $1`, [
        migration.version,
      ]);
    };

    if (hasTx) {
      await this.db.transaction(async (tx: MigrationTransactionalDb) => {
        try {
          await execWith(tx);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          throw new Error(`Rollback of migration ${migration.version} failed: ${errorMessage}`);
        }
      });
      return;
    }

    // Use local reference to avoid TypeScript narrowing this.db to never
    const db = this.db as PGlite;
    try {
      await db.exec('BEGIN');
      await execWith(db);
      await db.exec('COMMIT');
    } catch (error) {
      await db.exec('ROLLBACK');
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Rollback of migration ${migration.version} failed: ${errorMessage}`);
    }
  }

  /**
   * Rollback to a specific version
   */
  async down(migrations: Migration[], targetVersion = 0): Promise<void> {
    const appliedVersions = await this.getAppliedMigrations();
    const migrationsToRollback = migrations
      .filter((m) => appliedVersions.includes(m.version) && m.version > targetVersion)
      .sort((a, b) => b.version - a.version); // Reverse order

    for (const migration of migrationsToRollback) {
      await this.rollback(migration);
    }
  }

  /**
   * Get current schema version
   */
  async getCurrentVersion(): Promise<number> {
    const appliedMigrations = await this.getAppliedMigrations();
    return appliedMigrations.length > 0 ? Math.max(...appliedMigrations) : 0;
  }

  /**
   * Verify migration checksums
   */
  async verify(migrations: Migration[]): Promise<boolean> {
    for (const migration of migrations) {
      const result = await this.db.query<{ checksum: string }>(
        `SELECT checksum FROM ${MigrationRunner.MIGRATION_TABLE} WHERE version = $1`,
        [migration.version]
      );

      if (result.rows.length > 0) {
        const storedChecksum = result.rows[0]?.checksum;
        const currentChecksum = this.calculateChecksum(
          typeof migration.up === 'string' ? migration.up : migration.name
        );

        if (storedChecksum && storedChecksum !== currentChecksum) {
          this.logger.warn('Migration checksum mismatch', {
            version: migration.version,
            storedChecksum,
            currentChecksum,
          });
          return false;
        }
      }
    }
    return true;
  }
}
