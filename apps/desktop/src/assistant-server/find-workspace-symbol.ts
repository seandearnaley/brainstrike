export interface SymbolMatch {
  declarationLine: number; // 1-based line where the query matched
  endLine: number; // 1-based inclusive enclosing block end (best-effort)
  name: string; // trimmed declaration line text
  preview: string; // small numbered snippet around the declaration
  startLine: number; // 1-based inclusive enclosing block start
}

export interface FindSymbolResult {
  matches: SymbolMatch[];
  totalMatches: number;
  truncated: boolean;
}

export interface FindSymbolOptions {
  contextLines: number;
  maxMatches: number;
}

type StringDelimiter = '"' | "'" | '`';

interface BraceScanState {
  depth: number;
  inBlockComment: boolean;
  inString: StringDelimiter | null;
  pos: number;
}

function isStringDelimiter(ch: string): ch is StringDelimiter {
  return ch === '"' || ch === "'" || ch === '`';
}

/** Process one character when inside a block comment. Returns updated pos. */
function advanceBlockComment(state: BraceScanState, ch: string, next: string | undefined): void {
  if (ch === '*' && next === '/') {
    state.inBlockComment = false;
    state.pos += 1;
  }
}

/** Process one character when inside a string literal. Returns updated pos. */
function advanceInString(state: BraceScanState, ch: string): void {
  if (ch === '\\') {
    state.pos += 1;
    return;
  }
  if (ch === state.inString) {
    state.inString = null;
  }
}

/** Process one character in normal (unquoted, uncommented) code. Returns true to break. */
function advanceNormal(state: BraceScanState, ch: string, next: string | undefined): boolean {
  if (ch === '/' && next === '/') {
    return true; // line comment: stop scanning
  }
  if (ch === '/' && next === '*') {
    state.inBlockComment = true;
    state.pos += 1;
    return false;
  }
  if (isStringDelimiter(ch)) {
    state.inString = ch;
    return false;
  }
  if (ch === '{') {
    state.depth += 1;
  } else if (ch === '}') {
    state.depth -= 1;
  }
  return false;
}

/** Net brace depth delta for a line, ignoring braces inside line/block comments
 * and string/template literals. */
function braceDelta(line: string): number {
  const state: BraceScanState = { depth: 0, inString: null, inBlockComment: false, pos: 0 };
  while (state.pos < line.length) {
    const ch = line[state.pos] ?? '';
    const next = line[state.pos + 1];
    if (state.inBlockComment) {
      advanceBlockComment(state, ch, next);
    } else if (state.inString) {
      advanceInString(state, ch);
    } else {
      const stop = advanceNormal(state, ch, next);
      if (stop) {
        break;
      }
    }
    state.pos += 1;
  }
  return state.depth;
}

function indentWidth(line: string): number {
  const match = line.match(/^[ \t]*/);
  return match ? match[0].length : 0;
}

/** Best-effort enclosing block end index (0-based) for the declaration at declIndex. */
function resolveBlockEndIndex(lines: string[], declIndex: number): number {
  const lookahead = Math.min(declIndex + 5, lines.length - 1);
  let openIndex = -1;
  let depthAtOpen = 0;
  for (let i = declIndex; i <= lookahead; i += 1) {
    const delta = braceDelta(lines[i] ?? '');
    if (delta > 0) {
      openIndex = i;
      depthAtOpen = delta;
      break;
    }
  }
  if (openIndex >= 0) {
    let depth = depthAtOpen;
    for (let i = openIndex + 1; i < lines.length; i += 1) {
      depth += braceDelta(lines[i] ?? '');
      if (depth <= 0) {
        return i;
      }
    }
    return lines.length - 1;
  }
  const declIndent = indentWidth(lines[declIndex] ?? '');
  let end = declIndex;
  for (let i = declIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim().length === 0) {
      continue;
    }
    if (indentWidth(line) <= declIndent) {
      break;
    }
    end = i;
  }
  return end;
}

function buildPreview(lines: string[], declIndex: number, contextLines: number): string {
  const start = Math.max(0, declIndex - contextLines);
  const end = Math.min(lines.length - 1, declIndex + contextLines);
  const out: string[] = [];
  for (let i = start; i <= end; i += 1) {
    out.push(`${i + 1}: ${lines[i] ?? ''}`);
  }
  return out.join('\n');
}

export function findSymbolMatches(
  content: string,
  query: string,
  options: FindSymbolOptions
): FindSymbolResult {
  const lines = content.split('\n');
  const declIndexes: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if ((lines[i] ?? '').includes(query)) {
      declIndexes.push(i);
    }
  }
  const totalMatches = declIndexes.length;
  const capped = declIndexes.slice(0, Math.max(0, options.maxMatches));
  const matches: SymbolMatch[] = capped.map((declIndex) => {
    const endIndex = resolveBlockEndIndex(lines, declIndex);
    return {
      declarationLine: declIndex + 1,
      startLine: declIndex + 1,
      endLine: endIndex + 1,
      name: (lines[declIndex] ?? '').trim(),
      preview: buildPreview(lines, declIndex, options.contextLines),
    };
  });
  return { matches, totalMatches, truncated: totalMatches > matches.length };
}
