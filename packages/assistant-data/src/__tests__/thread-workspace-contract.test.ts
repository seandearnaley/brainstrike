import { THREAD_DELETE_SIDECAR_TABLES } from '@brainstrike/assistant-contract';
import { CURRENT_SCHEMA_DDL, getResetTables } from '@brainstrike/db';
import { describe, expect, it } from 'vitest';
import { requiredAssistantMemoryRelations } from '../assistant-memory-repository';

/**
 * Living-contract pins for `brainstrike_assistant_thread_workspaces`
 * (BST-1268; see docs/agents/database.md). A persistent sidecar carries FOUR
 * obligations beyond the schema itself — this suite fails if any of them drifts.
 */

const TABLE = 'brainstrike_assistant_thread_workspaces';

describe('thread workspace persistence contract', () => {
  it('the current-schema DDL is the SOLE declaration of the table', () => {
    // Was "migration 095 is the sole declaration of the table shape", which
    // grepped that migration's SQL for a byte-exact CREATE TABLE block. The
    // chain collapsed into one current-schema DDL (ADR-0020), so 095 is gone
    // and the DDL is now the single declaration.
    //
    // The obligation this pins is SOLENESS, not shape: a sidecar the
    // thread-delete cascade references unconditionally must be declared in
    // exactly ONE place, never mirrored in a renderer bootstrap (BST-1651). The
    // SHAPE is pinned far more strictly than a string compare could, by catalog
    // readback in packages/db/__tests__/fixtures/schema-catalog.snapshot.txt --
    // every column's type, nullability, default and ordinal.
    const declarations = CURRENT_SCHEMA_DDL.match(new RegExp(`CREATE TABLE "${TABLE}"`, 'gu'));
    expect(declarations, `${TABLE} declared in the current-schema DDL`).toHaveLength(1);
  });

  it('the repository PROBES for the table rather than creating it (BST-1651)', () => {
    // Pre-BST-1651 this obligation read "mirror the migration byte-identically
    // in the renderer bootstrap". The bootstrap is gone: a sidecar the
    // thread-delete cascade references unconditionally must instead be part of
    // the schema probe, so an un-migrated database fails by name up front.
    expect(requiredAssistantMemoryRelations()).toContain(TABLE);
  });

  it('thread deletion cascades the workspace row via the shared sidecar list', () => {
    expect(THREAD_DELETE_SIDECAR_TABLES).toContainEqual({
      table: TABLE,
      threadColumns: ['thread_id'],
    });
  });

  it('factory reset clears the table via the reset registry', () => {
    expect(getResetTables()).toContain(TABLE);
  });
});
