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
 * and string/template literals.
 *
 * Known limitation (best-effort, single pass): this scanner does NOT recognize
 * regex literals, so unbalanced braces inside one — e.g. `/[{]/` or `/\}/` — are
 * counted as real braces and can skew the delta for that line. Like the
 * multi-line string/comment caveat, this only affects the heuristic enclosing
 * range, which always stays bounded and path-safe. */
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

/** Bounded indentation-based block end index (0-based): the last line indented
 * deeper than the declaration. Used for brace-less languages AND as the bounded
 * fallback when a brace block opens but never balances. */
function resolveIndentBlockEndIndex(lines: string[], declIndex: number): number {
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
    // Braces opened but never balanced — almost always a mis-scan (regex /
    // template / cross-line comment, per braceDelta's documented limits), not a
    // genuine EOF-spanning block. Fall through to the bounded indentation
    // heuristic instead of returning `lines.length - 1` (a near-whole-file range
    // that defeats the precise-selection goal).
  }
  return resolveIndentBlockEndIndex(lines, declIndex);
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Keywords that introduce a named declaration whose identifier follows. */
const DECLARATION_KEYWORDS = 'function|class|interface|type|enum|struct|trait|fn|def|const|let|var';
/** Member/property/assignment-style declaration prefixes (class methods, object props). */
const MEMBER_PREFIXES = 'export|default|async|public|private|protected|static|readonly|get|set';

/**
 * Rank how strongly a matching line looks like the *declaration* of `query`
 * (vs. an import, call site, or partial-identifier collision). Higher is more
 * declaration-like — used so the real definition isn't crowded past `maxMatches`
 * by earlier usages. Substring-only matching is best-effort, so this is a
 * heuristic, not a parser.
 */
function declarationScore(line: string, escapedQuery: string): number {
  // `function add`, `class Add`, `const add =` — the query IS the declared name.
  const namedDecl = new RegExp(`\\b(?:${DECLARATION_KEYWORDS})\\s+${escapedQuery}\\b`);
  // Trimmed line starts with the query as a member/method/property declaration:
  // `add(`, `add:`, `add =`, optionally after `export`/`async`/`public`/... .
  const memberDecl = new RegExp(`^(?:(?:${MEMBER_PREFIXES})\\s+)*${escapedQuery}\\s*[(:=]`);
  if (namedDecl.test(line) || memberDecl.test(line.trimStart())) {
    return 2;
  }
  // Word-boundary match (a genuine use of the symbol, not e.g. `addItem`).
  if (new RegExp(`\\b${escapedQuery}\\b`).test(line)) {
    return 1;
  }
  // Substring-only collision (kept so totals/behavior are unchanged), ranked last.
  return 0;
}

export function findSymbolMatches(
  content: string,
  query: string,
  options: FindSymbolOptions
): FindSymbolResult {
  const lines = content.split('\n');
  const escapedQuery = escapeRegExp(query);
  const scored: Array<{ index: number; order: number; score: number }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.includes(query)) {
      scored.push({ index: i, order: scored.length, score: declarationScore(line, escapedQuery) });
    }
  }
  const totalMatches = scored.length;
  const capped = scored
    // Declaration-like lines first; ties preserve file order (stable via `order`).
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, Math.max(0, options.maxMatches))
    // Present the selected matches in file order for stable, readable output.
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.index);
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
