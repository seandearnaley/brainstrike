import type { FileFolderStatus } from './file-folder-status.ts';

/** A file folder status that is not open and not opening. */
export type ClosedFolder = Extract<FileFolderStatus, { kind: 'closed' }>;

const UNNAMED_FOLDER = "This file's folder";

/** The one set of words every surface uses for a file's folder, so they never disagree. */
export function openingFolderLabel(name: string | null): string {
  return `Opening ${name ?? "this file's folder"}…`;
}

export function closedFolderWords(
  status: ClosedFolder,
  canReopen: boolean
): { readonly detail: string; readonly reopen: string; readonly title: string } {
  const folder = status.name ?? UNNAMED_FOLDER;
  if (status.failure !== null) {
    return { detail: status.failure, reopen: 'Try again', title: `${folder} can't be opened` };
  }
  return {
    detail: canReopen
      ? 'Reopen the folder to see this file.'
      : 'It opens again with the thread that works in it.',
    reopen: 'Reopen folder',
    title: `${folder} is closed`,
  };
}
