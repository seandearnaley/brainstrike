/**
 * A Finder folder drop → absolute paths to REQUEST (BST-1393, spec §4.1
 * [D7]).
 *
 * Everything here is SYNCHRONOUS, on purpose. A `DataTransferItem` is invalid
 * the moment the drop event settles, so both `webkitGetAsEntry()` and
 * `getAsFile()` must be called inside the drop tick — the contract
 * `packages/notes-vault/src/core/drop.ts` established and whose test proves by
 * invalidating the item after one microtask. This module needs no `await` at
 * all: unlike the vault's FSA path, `getPathForFile` is synchronous.
 *
 * Files vs folders are told apart by ASKING the DOM (`entry.isDirectory`),
 * never by guessing from `size`/`type` and never by forwarding everything to
 * main (ruling D1): a plain file sent to `fs:addRootByPath` comes back with a
 * message about GRANTS, which misdescribes the problem.
 *
 * Every non-outcome is COUNTED, not swallowed: the caller states them. There
 * are three, kept separate so the notice never names the wrong noun (ruling
 * D1): plain files (`skippedFileCount`), items whose kind could never be
 * read (`unreadableCount`), and confirmed folders whose path failed to
 * resolve (`unresolvedCount`).
 */
export interface DroppableFolderItem {
  readonly getAsFile: () => File | null;
  readonly kind: string;
  readonly webkitGetAsEntry: () => { readonly isDirectory: boolean } | null;
}

export interface DroppedFolderPaths {
  /** Absolute, deduped, in drop order. */
  readonly paths: readonly string[];
  /** Dropped items that were plain files. */
  readonly skippedFileCount: number;
  /**
   * Items `webkitGetAsEntry()` threw on — kind (file vs. folder) is UNKNOWN,
   * so this is counted separately from `unresolvedCount` rather than folded
   * into it (review finding, ruling D1's misdescription class): telling a
   * user "N folders could not be read" about an item that might have been a
   * plain file is the same wrong-noun mistake D1 exists to prevent, just one
   * layer up from the GRANTS-message case.
   */
  readonly unreadableCount: number;
  /** Directories whose `File` yielded no path (not disk-backed, or unreadable). */
  readonly unresolvedCount: number;
}

export function extractDroppedFolderPaths(
  items: Iterable<DroppableFolderItem>,
  resolvePath: (file: File) => string
): DroppedFolderPaths {
  const seen = new Set<string>();
  const paths: string[] = [];
  let skippedFileCount = 0;
  let unreadableCount = 0;
  let unresolvedCount = 0;

  for (const item of items) {
    if (item.kind !== 'file') {
      continue;
    }
    let isDirectory = false;
    let file: File | null = null;
    try {
      isDirectory = item.webkitGetAsEntry()?.isDirectory === true;
      file = isDirectory ? item.getAsFile() : null;
    } catch {
      // The item became unusable (or the browser refused it) before its kind
      // could even be read. Counted separately from unresolvedCount: this
      // item was never confirmed to BE a folder.
      unreadableCount += 1;
      continue;
    }
    if (!isDirectory) {
      skippedFileCount += 1;
      continue;
    }
    const resolved = file ? resolvePath(file) : '';
    if (resolved.length === 0) {
      unresolvedCount += 1;
      continue;
    }
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    paths.push(resolved);
  }

  return { paths, skippedFileCount, unreadableCount, unresolvedCount };
}
