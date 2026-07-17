import type { VaultRootState } from './rows';
import { makeVaultNodeId, type VaultNoteNode, type VaultTreeNode } from './types';

/**
 * Resolves a relative markdown link against the linking note's path segments.
 * Returns the target's root-relative segments, or null when the link is not
 * an in-vault relative path (absolute, protocol-qualified, or escaping the
 * vault root) — the caller treats those as external links.
 */
export function resolveRelativeNoteSegments(
  baseSegments: readonly string[],
  href: string
): string[] | null {
  if (href.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return null;
  }
  // URL semantics: a raw '#' starts a fragment and '?' a query — files whose
  // names contain them must percent-encode. Heading links (note.md#section)
  // therefore resolve to the note itself.
  const path = href.split(/[#?]/, 1)[0] ?? '';
  const resolved = baseSegments.slice(0, -1);
  for (const rawSegment of path.split('/')) {
    if (rawSegment === '' || rawSegment === '.') {
      continue;
    }
    if (rawSegment === '..') {
      if (resolved.length === 0) {
        return null;
      }
      resolved.pop();
      continue;
    }
    try {
      resolved.push(decodeURIComponent(rawSegment));
    } catch {
      resolved.push(rawSegment);
    }
  }
  return resolved.length > 0 ? resolved : null;
}

function findNoteInNodes(nodes: readonly VaultTreeNode[], noteId: string): VaultNoteNode | null {
  for (const node of nodes) {
    if (node.type === 'note' && node.id === noteId) {
      return node;
    }
    if (node.type === 'folder' && noteId.startsWith(`${node.id}/`)) {
      return findNoteInNodes(node.children, noteId);
    }
  }
  return null;
}

function findEntryInNodes(nodes: readonly VaultTreeNode[], entryId: string): VaultTreeNode | null {
  for (const node of nodes) {
    if (node.id === entryId) {
      return node;
    }
    if (node.type === 'folder' && entryId.startsWith(`${node.id}/`)) {
      return findEntryInNodes(node.children, entryId);
    }
  }
  return null;
}

/** Finds any tree entry (note or folder) by id across roots. */
export function findVaultEntry(
  roots: readonly VaultRootState[],
  entryId: string
): VaultTreeNode | null {
  for (const root of roots) {
    if (entryId.startsWith(`${root.rootId}:`)) {
      return findEntryInNodes(root.nodes, entryId);
    }
  }
  return null;
}

export function findVaultNote(
  roots: readonly VaultRootState[],
  noteId: string
): VaultNoteNode | null {
  for (const root of roots) {
    if (noteId.startsWith(`${root.rootId}:`)) {
      return findNoteInNodes(root.nodes, noteId);
    }
  }
  return null;
}

/** Id a resolved relative link would have inside the given root. */
export function noteIdForSegments(rootId: string, segments: readonly string[]): string {
  return makeVaultNodeId(rootId, segments);
}
