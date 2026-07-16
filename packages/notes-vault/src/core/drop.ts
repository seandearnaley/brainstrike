import type { VaultDirectoryHandleLike, VaultHandleLike } from './types';

/** Structural subset of DataTransferItem the vault drop intake needs. */
export interface DroppableItem {
  getAsFileSystemHandle?(): Promise<VaultHandleLike | null> | VaultHandleLike | null;
  readonly kind: string;
}

export interface DroppedVaultDirectories {
  readonly directories: VaultDirectoryHandleLike[];
  /** Dropped items that resolved to plain files (not mountable as vaults). */
  readonly skippedFileCount: number;
  /** True when no dropped item exposed getAsFileSystemHandle (non-Chromium). */
  readonly unsupported: boolean;
}

/**
 * Extracts directory handles from a drop event's DataTransferItems.
 *
 * Drop-tick contract: getAsFileSystemHandle() MUST be called synchronously
 * for every item before the first await — the browser invalidates
 * DataTransferItems once the drop event handler yields. Collect all
 * promises first, then settle them together.
 */
export async function extractDroppedVaultDirectories(
  items: Iterable<DroppableItem>
): Promise<DroppedVaultDirectories> {
  const pending: (Promise<VaultHandleLike | null> | VaultHandleLike | null)[] = [];
  let sawFileItem = false;
  let supported = false;
  for (const item of items) {
    if (item.kind !== 'file') {
      continue;
    }
    sawFileItem = true;
    if (typeof item.getAsFileSystemHandle !== 'function') {
      continue;
    }
    supported = true;
    pending.push(item.getAsFileSystemHandle());
  }

  const handles = await Promise.all(pending);
  const directories: VaultDirectoryHandleLike[] = [];
  let skippedFileCount = 0;
  for (const handle of handles) {
    if (handle?.kind === 'directory') {
      directories.push(handle);
    } else if (handle?.kind === 'file') {
      skippedFileCount += 1;
    }
  }
  return { directories, skippedFileCount, unsupported: sawFileItem && !supported };
}
