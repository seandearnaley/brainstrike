/**
 * Context-action target adapters for the debug drawer's rows.
 *
 * Replaces the `collection-target.ts` producer the retired Collection Browser
 * owned, reduced to the two row kinds this drawer actually renders. Targets
 * are immutable invocation snapshots (ui-conventions CONTEXT ACTION SYSTEM):
 * each adapter copies the primitive fields it needs so a later store update or
 * row recycle can never mutate a target a menu is already holding.
 */

import type { ContextTarget } from '@brainstrike/context-actions';

export interface DrawerFileRow {
  id: string;
  name: string;
  path: string | null;
}

export interface DrawerChunkRow {
  content: string;
  id: string;
}

export function fileRowToTarget(
  row: DrawerFileRow
): Extract<ContextTarget, { kind: 'collection-file' }> {
  return {
    id: row.id,
    kind: 'collection-file',
    name: row.name,
    path: row.path,
  };
}

export function chunkRowToTarget(row: DrawerChunkRow): Extract<ContextTarget, { kind: 'chunk' }> {
  return {
    content: row.content,
    id: row.id,
    kind: 'chunk',
  };
}
