/**
 * The live grep pass's non-silent note composer, split from `live-grep.ts`.
 * Caps, time limits and unreadable folders are surfaced here so a search's
 * limits are never hidden.
 */
/** Compose the non-silent live-pass note (cap and coverage warnings), or undefined when clean. */
export function buildLiveNote(args: {
  partialReadErrors: boolean;
  scanLimited: boolean;
  candidateTruncated: boolean;
  prefilterTruncated: boolean;
  timedOut: boolean;
  /** Display names of folders whose root could not be opened, so they were not searched. */
  unreadableRoots?: readonly string[];
}): string | undefined {
  const parts: string[] = [];
  const unreadable = args.unreadableRoots ?? [];
  if (unreadable.length > 0) {
    const names = unreadable.map((name) => `"${name}"`).join(', ');
    parts.push(
      `${unreadable.length === 1 ? 'Folder' : 'Folders'} ${names} could not be read on disk and ${unreadable.length === 1 ? 'was' : 'were'} not searched.`
    );
  }
  if (args.partialReadErrors) {
    parts.push(
      'ripgrep reported unreadable files during the live pass; matches inside unreadable files may be missing.'
    );
  }
  if (args.timedOut) {
    parts.push(
      'ripgrep reached its time limit, so some on-disk matches may be missing; narrow the pattern or scope.'
    );
  }
  if (args.scanLimited) {
    parts.push(
      'This regex has no literal ripgrep can prefilter on, so files were scanned directly and the scan stopped at its file cap; some matches may be missing.'
    );
  }
  if (args.candidateTruncated) {
    parts.push(
      'The live pass hit its candidate-file cap; narrow the pattern or scope with filePaths to reach the rest.'
    );
  }
  if (args.prefilterTruncated) {
    parts.push(
      'The live ripgrep prefilter output was truncated; some on-disk matches may be missing.'
    );
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}
