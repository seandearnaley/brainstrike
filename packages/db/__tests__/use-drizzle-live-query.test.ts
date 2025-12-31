/**
 * Tests for Drizzle Live Query Hook
 *
 * Validates the type-safe wrapper around usePGliteLiveQuery that works
 * with Drizzle query builders.
 */

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { describe, expect, it } from 'vitest';
import * as schema from '../src/schema/index.js';
import { fileRecords } from '../src/schema/index.js';

describe('useDrizzleLiveQuery', () => {
  describe('toSQL() extraction', () => {
    it('should extract SQL and params from a simple select query', () => {
      // Create a mock Drizzle instance (just for query building, not execution)
      const db = drizzle({
        // @ts-expect-error - mock client for testing toSQL only
        client: { query: async () => ({ rows: [] }) },
        schema,
      });

      const query = db.select().from(fileRecords);
      const { sql, params } = query.toSQL();

      expect(sql).toContain('select');
      expect(sql).toContain('"file_records"');
      expect(Array.isArray(params)).toBe(true);
    });

    it('should extract SQL with where clause and parameters', () => {
      const db = drizzle({
        // @ts-expect-error - mock client for testing toSQL only
        client: { query: async () => ({ rows: [] }) },
        schema,
      });

      const query = db.select().from(fileRecords).where(eq(fileRecords.size, 100));
      const { sql, params } = query.toSQL();

      expect(sql).toContain('select');
      expect(sql).toContain('"file_records"');
      expect(sql).toContain('where');
      expect(params).toContain(100);
    });

    it('should extract SQL with multiple conditions', () => {
      const db = drizzle({
        // @ts-expect-error - mock client for testing toSQL only
        client: { query: async () => ({ rows: [] }) },
        schema,
      });

      const query = db
        .select()
        .from(fileRecords)
        .where(eq(fileRecords.name, 'test.txt'))
        .limit(10)
        .offset(5);

      const { sql, params } = query.toSQL();

      expect(sql).toContain('select');
      expect(sql).toContain('"file_records"');
      expect(sql).toContain('limit');
      expect(sql).toContain('offset');
      expect(params).toContain('test.txt');
    });

    it('should support field selection', () => {
      const db = drizzle({
        // @ts-expect-error - mock client for testing toSQL only
        client: { query: async () => ({ rows: [] }) },
        schema,
      });

      const query = db
        .select({
          id: fileRecords.id,
          name: fileRecords.name,
          size: fileRecords.size,
        })
        .from(fileRecords);

      const { sql } = query.toSQL();

      expect(sql).toContain('select');
      expect(sql).toContain('"id"');
      expect(sql).toContain('"name"');
      expect(sql).toContain('"size"');
    });

    it('should support orderBy clause', () => {
      const db = drizzle({
        // @ts-expect-error - mock client for testing toSQL only
        client: { query: async () => ({ rows: [] }) },
        schema,
      });

      const query = db.select().from(fileRecords).orderBy(fileRecords.createdAt);

      const { sql } = query.toSQL();

      expect(sql).toContain('select');
      expect(sql).toContain('order by');
    });
  });

  describe('query type inference', () => {
    it('should produce type-compatible SQL for live queries', () => {
      const db = drizzle({
        // @ts-expect-error - mock client for testing toSQL only
        client: { query: async () => ({ rows: [] }) },
        schema,
      });

      // Build a query that would be passed to useDrizzleLiveQuery
      const query = db.select().from(fileRecords).where(eq(fileRecords.size, 100));

      // Extract query details
      const { sql, params } = query.toSQL();

      // Verify the SQL is in a format that usePGliteLiveQuery expects
      expect(typeof sql).toBe('string');
      expect(sql.length).toBeGreaterThan(0);
      expect(Array.isArray(params)).toBe(true);

      // The SQL should be a valid parameterized query
      // $1, $2, etc. are the parameter placeholders used by PostgreSQL
      if (params.length > 0) {
        expect(sql).toContain('$');
      }
    });
  });
});
