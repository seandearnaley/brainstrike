/**
 * A strict reader for git's unified patches, as a renderer reads them: every
 * hunk's body must hold exactly the lines its `@@` header counts, and nothing
 * but a hunk or a file section may follow a hunk.
 */
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/u;

export interface ParsedPatch {
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: number;
}

export function parsePatch(patch: string): ParsedPatch {
  const lines = patch.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  let additions = 0;
  let deletions = 0;
  let hunks = 0;
  let index = 0;
  while (index < lines.length) {
    const header = HUNK_HEADER.exec(lines[index] ?? '');
    index += 1;
    if (!header) {
      continue;
    }
    hunks += 1;
    let oldLeft = header[1] === undefined ? 1 : Number(header[1]);
    let newLeft = header[2] === undefined ? 1 : Number(header[2]);
    while (oldLeft > 0 || newLeft > 0) {
      const body = lines[index];
      if (body === undefined) {
        throw new Error(`hunk ${hunks} ends before its counts are met`);
      }
      index += 1;
      if (body.startsWith('\\')) {
        continue;
      }
      if (body.startsWith(' ')) {
        oldLeft -= 1;
        newLeft -= 1;
      } else if (body.startsWith('-')) {
        oldLeft -= 1;
        deletions += 1;
      } else if (body.startsWith('+')) {
        newLeft -= 1;
        additions += 1;
      } else {
        throw new Error(`hunk ${hunks} holds a line no parser accepts: ${JSON.stringify(body)}`);
      }
      if (oldLeft < 0 || newLeft < 0) {
        throw new Error(`hunk ${hunks} holds more lines than its header counts`);
      }
    }
    while (lines[index]?.startsWith('\\')) {
      index += 1;
    }
    const next = lines[index];
    if (next !== undefined && !next.startsWith('@@ ') && !next.startsWith('diff --git ')) {
      throw new Error(`hunk ${hunks} is followed by a stray line: ${JSON.stringify(next)}`);
    }
  }
  return { additions, deletions, hunks };
}
