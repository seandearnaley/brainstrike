/**
 * Drizzle ORM Module
 *
 * This module provides Drizzle ORM utilities and exports all Drizzle-based
 * repositories for type-safe database operations.
 */

// Database utilities
export {
  type DrizzleDb,
  drizzle,
  drizzleFromHandle,
  extractPGlite,
  hasPGliteRaw,
} from './database.js';
// Migration utilities
export { computeLedgerHead, getBundledLedgerHead, runMigrations } from './migrate.js';
