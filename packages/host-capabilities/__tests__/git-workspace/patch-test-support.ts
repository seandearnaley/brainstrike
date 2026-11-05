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

const SPLIT_LINES = /(?<=\n)/u;

/**
 * A reference patcher, independent of git: `old` with `hunks` applied in
 * order, each hunk checked against the old lines it claims. Throws when a
 * hunk does not fit.
 */
export function applyHunks(old: string, hunks: readonly string[]): string {
  const lines = old.split(SPLIT_LINES).filter((line) => line.length > 0);
  const result: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const [header = '', ...body] = hunk.split(SPLIT_LINES);
    const match = HUNK_HEADER.exec(header);
    if (!match) {
      throw new Error(`not a hunk: ${JSON.stringify(header)}`);
    }
    const start = Number(/^@@ -(\d+)/u.exec(header)?.[1]);
    const at = match[1] === '0' ? start : start - 1;
    if (at < cursor) {
      throw new Error('hunks overlap or are out of order');
    }
    result.push(...lines.slice(cursor, at));
    cursor = at;
    for (const [index, line] of body.entries()) {
      if (line.startsWith('\\')) {
        continue;
      }
      const text = body[index + 1]?.startsWith('\\') ? line.slice(1, -1) : line.slice(1);
      if (line.startsWith('+')) {
        result.push(text);
        continue;
      }
      if (lines[cursor] !== text) {
        throw new Error(`old line ${cursor + 1} is not the hunk's: ${JSON.stringify(text)}`);
      }
      if (line.startsWith(' ')) {
        result.push(text);
      }
      cursor += 1;
    }
  }
  return [...result, ...lines.slice(cursor)].join('');
}
