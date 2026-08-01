import type { StorageThreadType } from '@mastra/core/memory';
import {
  DEFAULT_THREAD_TITLE,
  THREAD_TITLE_SOURCE_METADATA_KEY,
  THREAD_TITLE_SOURCE_OM,
} from './sql';

function isEmptyThreadTitle(title: string | null | undefined): boolean {
  return title === null || title === undefined || title.trim() === '';
}

function hasOmTitleMarker(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.[THREAD_TITLE_SOURCE_METADATA_KEY] === THREAD_TITLE_SOURCE_OM;
}

/**
 * Decide whether an automated memory write may replace the stored title.
 * Overwritable when the existing title is empty (never set), carries the
 * `titleSource: 'om'` marker (a seeded placeholder or a prior auto-title
 * write), or is the literal `DEFAULT_THREAD_TITLE` with no marker at all —
 * never when it is any other title the user explicitly set, which is
 * written through the dedicated raw-SQL rename path that clears the marker.
 *
 * The `DEFAULT_THREAD_TITLE` fallback is a legacy back-compat allowance:
 * threads seeded before the OM marker existed have title 'New Thread' and
 * no `titleSource` metadata at all, so without it they would read as
 * user-owned forever and never receive an automatic title. Accepted
 * tradeoff: a user who manually renames a thread to exactly
 * 'New Thread' loses that title to the next auto-title write — negligible
 * relative to unblocking every pre-existing thread.
 */
export function canOverwriteThreadTitle(existing: StorageThreadType | null): boolean {
  if (!existing) {
    return true;
  }
  return (
    isEmptyThreadTitle(existing.title) ||
    hasOmTitleMarker(existing.metadata) ||
    existing.title === DEFAULT_THREAD_TITLE
  );
}

interface ThreadSaveResolution {
  readonly effectiveCreatedAt: Date;
  readonly effectiveMetadata: Record<string, unknown> | undefined;
  readonly effectiveTitle: string;
  readonly effectiveUpdatedAt: Date;
  readonly preservedGeneratedTitle: boolean;
  readonly proposedTitle: string;
}

export function resolveThreadSave(
  existing: StorageThreadType | null,
  thread: StorageThreadType
): ThreadSaveResolution {
  const proposedTitle = thread.title ?? DEFAULT_THREAD_TITLE;
  const applyProposedTitle =
    !existing || (!isEmptyThreadTitle(proposedTitle) && canOverwriteThreadTitle(existing));
  const effectiveTitle = applyProposedTitle ? proposedTitle : (existing?.title ?? proposedTitle);
  const existingTitle = existing?.title ?? '';
  const titleChanged = effectiveTitle.trim() !== existingTitle.trim();
  const isGeneratedTitleWrite = Boolean(existing && titleChanged);
  const isSystemPlaceholderInsert =
    !existing &&
    (thread.title === null || thread.title === undefined || proposedTitle === DEFAULT_THREAD_TITLE);

  let effectiveMetadata: Record<string, unknown> | undefined;
  if (isGeneratedTitleWrite || isSystemPlaceholderInsert) {
    effectiveMetadata = {
      ...existing?.metadata,
      ...thread.metadata,
      [THREAD_TITLE_SOURCE_METADATA_KEY]: THREAD_TITLE_SOURCE_OM,
    };
  } else if (existing) {
    effectiveMetadata = existing.metadata;
  } else {
    effectiveMetadata = thread.metadata;
  }

  return {
    effectiveCreatedAt: existing?.createdAt ?? thread.createdAt,
    effectiveMetadata,
    effectiveTitle,
    effectiveUpdatedAt:
      existing && existing.updatedAt > thread.updatedAt ? existing.updatedAt : thread.updatedAt,
    preservedGeneratedTitle: Boolean(
      existing &&
        !applyProposedTitle &&
        !isEmptyThreadTitle(proposedTitle) &&
        proposedTitle.trim() !== existingTitle.trim()
    ),
    proposedTitle,
  };
}
