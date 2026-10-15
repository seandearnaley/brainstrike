const FORWARD_SLASH_CODE = 47;

/**
 * Show only the trailing two segments of a path, prefixed with `.../` when truncated.
 * Used for compact progress indicators where horizontal space is tight.
 */
export function formatTrailingPathSegments(path: string): string {
  let segmentCount = 0;
  let inSegment = false;
  let trailingStartIndex = 0;

  // Progress updates call this for every active path; scan backward so we only
  // slice the final two real segments instead of allocating every segment.
  for (let i = path.length - 1; i >= 0; i -= 1) {
    if (path.charCodeAt(i) === FORWARD_SLASH_CODE) {
      if (inSegment) {
        segmentCount += 1;
        if (segmentCount === 2) {
          trailingStartIndex = i + 1;
        }
        inSegment = false;
      }
      continue;
    }

    inSegment = true;
  }

  if (inSegment) {
    segmentCount += 1;
    if (segmentCount === 2) {
      trailingStartIndex = 0;
    }
  }

  return segmentCount > 2 ? `.../${path.slice(trailingStartIndex)}` : path;
}
