import type { AssistantWorkspaceTapestryUpdatePayload } from '@brainstrike/types';
import { normalizeWorkspaceLookupPath } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';
import { decodeFileSelection, encodeFileSelection } from '@brainstrike/utils/selection-utils';
import { buildAssistantTapestryRange } from './assistant-ui-panel-wrapper-runtime';

const logger = createLogger('AssistantSelectionWriteBack');

/**
 * Normalize an absolute root path for matching the server's broadcast rootPath
 * (path.resolve output) against the client's rootDescriptors[].path. Strips a
 * trailing separator so a `/foo/bar/` vs `/foo/bar` mismatch still resolves. The
 * deeper realpath/case match is desktop-only and verified live.
 */
export function normalizeRootPathForLookup(rootPath: string): string {
  return rootPath.trim().replace(/[/\\]+$/, '');
}

/**
 * Resolve which client folder a multi-root selection write-back targets. When the
 * payload carries a `rootPath` (the assistant targeted a specific open folder),
 * map it to the client RootId via rootDescriptors. Returns null (and logs) when
 * the path matches no open client root — the caller MUST skip rather than write
 * to the wrong/focused folder. Without a rootPath, route by the legacy folderId.
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
