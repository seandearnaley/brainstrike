import type { AssistantWorkspaceTapestryUpdatePayload } from '@brainstrike/types';
import { normalizeWorkspaceLookupPath } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';
import { decodeFileSelection, encodeFileSelection } from '@brainstrike/utils/selection-utils';
import { buildAssistantTapestryRange } from './assistant-ui-panel-wrapper-runtime';

const logger = createLogger('AssistantSelectionWriteBack');

/** Normalize an absolute root path before matching it to an open client root. */
export function normalizeRootPathForLookup(rootPath: string): string {
  return rootPath.trim().replace(/[/\\]+$/, '');
}

/**
 * Resolve the client folder targeted by an assistant selection write-back.
 * Returns null when a server root path is not open in this window so callers
 * cannot accidentally write into the focused folder instead.
 */
export function resolveWriteBackFolderId(
  payload: { folderId?: string; rootPath?: string; rootId?: string },
  pathToClientRootId: ReadonlyMap<string, string>
): string | null {
  if (payload.rootPath === undefined) {
    return payload.folderId ?? null;
  }
  const clientRootId = pathToClientRootId.get(normalizeRootPathForLookup(payload.rootPath));
  if (!clientRootId) {
    logger.warn(
      'Selection write-back targets a root not open in this window; dropping (no client folder).',
      { rootId: payload.rootId, rootPath: payload.rootPath }
    );
    return null;
  }
  return clientRootId;
}

/** Normalize, dedupe, and root-anchor write-back file paths to leading-slash form. */
export function normalizeWriteBackFilePaths(filePaths: readonly unknown[]): string[] {
  return Array.from(
    new Set(
      filePaths
        .map((filePath) => normalizeWorkspaceLookupPath(String(filePath)))
        .filter((filePath) => filePath.length > 0)
        .map((filePath) => (filePath.startsWith('/') ? filePath : `/${filePath}`))
    )
  );
}

/** Replace one folder's selection while preserving other folders and invalid legacy keys. */
export function computeReplacedSelection(
  currentSelection: Iterable<string>,
  targetFolderId: string,
  normalizedPaths: readonly string[]
): Set<string> {
  const next = new Set<string>();
  for (const compositeKey of currentSelection) {
    try {
      if (decodeFileSelection(compositeKey).folderId !== targetFolderId) {
        next.add(compositeKey);
      }
    } catch {
      next.add(compositeKey);
    }
  }
  for (const filePath of normalizedPaths) {
    next.add(encodeFileSelection(targetFolderId, filePath));
  }
  return next;
}

/** Build the Tapestry ranges for one file update (empty for clear mode). */
export function buildTapestryRangesForUpdate(
  ranges: AssistantWorkspaceTapestryUpdatePayload['updates'][number]['ranges'],
  compositeKey: string,
  clear: boolean
): ReturnType<typeof buildAssistantTapestryRange>[] {
  if (clear) {
    return [];
  }
  return ranges.map((range, index) =>
    buildAssistantTapestryRange({
      ...(range.color ? { color: range.color } : {}),
      compositeKey,
      endLine: range.endLine,
      index,
      isActive: range.isActive,
      startLine: range.startLine,
    })
  );
}
