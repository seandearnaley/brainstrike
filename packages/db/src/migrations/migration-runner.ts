import type { PGlite } from '@electric-sql/pglite';

export interface Migration {
  version: number;
  name: string;
  up: string;
  down?: string;
}

export class MigrationRunner {
  private static MIGRATION_TABLE = '_migrations';

  constructor(private db: PGlite) {}

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
    const isApplied = await this.isApplied(migration.version);
    if (isApplied) {
      console.info(`Migration ${migration.version} is already applied, skipping`);
      return;
    }

    try {
      // Start transaction
      await this.db.exec('BEGIN');

      // Execute migration
      await this.db.exec(migration.up);

      // Record migration
      const checksum = this.calculateChecksum(migration.up);
      await this.db.query(
        `INSERT INTO ${MigrationRunner.MIGRATION_TABLE} (version, name, checksum) VALUES ($1, $2, $3)`,
        [migration.version, migration.name, checksum]
      );

      // Commit transaction
      await this.db.exec('COMMIT');
    } catch (error) {
      // Rollback on error
      await this.db.exec('ROLLBACK');
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Migration ${migration.version} failed: ${errorMessage}`);
    }
  }

  /**
   * Run all pending migrations
   */
  async up(migrations: Migration[]): Promise<void> {
    // Sort migrations by version
    const sortedMigrations = [...migrations].sort((a, b) => a.version - b.version);

    for (const migration of sortedMigrations) {
      await this.runMigration(migration);
    }
  }

  /**
   * Rollback a specific migration
   */
  async rollback(migration: Migration): Promise<void> {
    if (!migration.down) {
      throw new Error(`Migration ${migration.version} does not support rollback`);
    }

    const isApplied = await this.isApplied(migration.version);
    if (!isApplied) {
      console.info(`Migration ${migration.version} is not applied, skipping rollback`);
      return;
    }

    try {
      // Start transaction
      await this.db.exec('BEGIN');

      // Execute rollback
      await this.db.exec(migration.down);

      // Remove migration record
      await this.db.query(`DELETE FROM ${MigrationRunner.MIGRATION_TABLE} WHERE version = $1`, [
        migration.version,
      ]);

      // Commit transaction
      await this.db.exec('COMMIT');
    } catch (error) {
      // Rollback on error
      await this.db.exec('ROLLBACK');
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
        const currentChecksum = this.calculateChecksum(migration.up);

        if (storedChecksum && storedChecksum !== currentChecksum) {
          console.warn(
            `Migration ${migration.version} checksum mismatch: stored=${storedChecksum}, current=${currentChecksum}`
          );
          return false;
        }
      }
    }
    return true;
  }
}
