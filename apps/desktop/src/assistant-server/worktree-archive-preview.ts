import { promises as fsPromises } from 'node:fs';
import type { GitResult, WorktreeArchivePreview } from '@brainstrike/types';
import type { WorktreeSafetyReport } from './worktree-archive';

const EMPTY_ARCHIVE_PREVIEW: WorktreeArchivePreview = {
  confirmationToken: null,
  ignoredEntryCount: 0,
  ignoredTopLevelEntries: [],
  ignoredTopLevelEntriesTruncated: false,
  ignoredTopLevelEntryCount: 0,
};

export function ignoredEntriesArchiveBlocker(safety: WorktreeSafetyReport): string {
  const count = safety.ignoredEntryCount;
  const noun = count === 1 ? 'entry' : 'entries';
  const paths = safety.ignoredTopLevelEntries.join(', ');
  const hiddenTopLevelCount =
    safety.ignoredTopLevelEntryCount - safety.ignoredTopLevelEntries.length;
  const suffix =
    hiddenTopLevelCount > 0
      ? `, and ${hiddenTopLevelCount} other top-level path${hiddenTopLevelCount === 1 ? '' : 's'}`
      : '';
  return `This worktree has ${count} ignored ${noun} that ${
    count === 1 ? 'is' : 'are'
  } not in the archive snapshot and will be permanently deleted. Top-level paths: ${paths}${suffix}. Confirm this deletion to archive.`;
}

export async function worktreePathExists(worktreePath: string): Promise<boolean> {
  try {
    await fsPromises.stat(worktreePath);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export async function inspectWorktreeArchivePreviewForPath(input: {
  readonly inspectSafety: () => Promise<GitResult<WorktreeSafetyReport>>;
  readonly path: string;
}): Promise<GitResult<WorktreeArchivePreview>> {
  if (!(await worktreePathExists(input.path))) {
    return { ok: true, value: EMPTY_ARCHIVE_PREVIEW };
  }
  const safety = await input.inspectSafety();
  if (!safety.ok) {
    return safety;
  }
  return {
    ok: true,
    value: {
      confirmationToken: safety.value.ignoredEntriesConfirmationToken,
      ignoredEntryCount: safety.value.ignoredEntryCount,
      ignoredTopLevelEntries: safety.value.ignoredTopLevelEntries,
      ignoredTopLevelEntriesTruncated: safety.value.ignoredTopLevelEntriesTruncated,
      ignoredTopLevelEntryCount: safety.value.ignoredTopLevelEntryCount,
    },
  };
}
