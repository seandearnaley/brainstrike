/**
 * The live grep pass's non-silent note composer, split from `live-grep.ts`
 * (that file sits at the 1000-line lint ceiling). Degradations and caps are
 * surfaced to the model here so freshness limits are never hidden.
 */
/** Compose the non-silent live-pass note (degradation + cap warnings), or undefined when clean. */
export function buildLiveNote(args: {
  exactScope?: boolean;
  rgPresent: boolean;
  rgUsed: boolean;
  regexNoLiteralPrefilter: boolean;
  degradedToWalk: boolean;
  degradeReason: string | null;
  partialReadErrors: boolean;
  scanLimited: boolean;
  candidateTruncated: boolean;
  prefilterTruncated: boolean;
}): string | undefined {
  const parts: string[] = [];
  if (args.partialReadErrors) {
    parts.push(
      'ripgrep reported unreadable files during the live pass; matches inside unreadable files may be missing.'
    );
  }
  if (args.exactScope) {
    // Direct file scopes need no prefilter and no root walk.
  } else if (!args.rgPresent) {
    parts.push('ripgrep is unavailable; the live (on-disk) pass used a bounded file-walk instead.');
  } else if (args.degradedToWalk) {
    parts.push(
      `ripgrep failed (${args.degradeReason ?? 'unknown error'}); the live pass fell back to a bounded file-walk.`
    );
  } else if (args.regexNoLiteralPrefilter) {
    // rg is present but was deliberately not used: this regex has no literal that
    // rg could prefilter on as a guaranteed superset, so the live pass scanned
    // candidate files directly with the authoritative matcher (consistent with
    // the indexed path's scanLimited regex case) rather than trusting rg's
    // narrower regex dialect. Never silent.
    parts.push(
      'The live pass scanned on-disk files without a ripgrep prefilter ' +
        '(this regex has no extractable literal), so it was bounded by the file-walk cap.'
    );
  }
  if (args.scanLimited) {
    parts.push(
      'The live file-walk hit its per-root visit cap, so some on-disk matches may be missing.'
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
