/**
 * Pattern utilities for grep-style search.
 *
 * escapeLikeLiteral: makes user text safe to embed in a LIKE/ILIKE pattern
 * (used with `ESCAPE '\'` in SQL).
 *
 * extractTrigramLiteral: conservatively extracts the longest literal substring
 * that a JS regex GUARANTEES to be present in any match, so it can drive a
 * trigram-indexed ILIKE prefilter. Returns null when no literal of at least
 * MIN_TRIGRAM_LITERAL_LENGTH chars is guaranteed — the caller must then fall
 * back to a bounded scan and surface that explicitly (no silent degradation).
 */

export const MIN_TRIGRAM_LITERAL_LENGTH = 3;

export function escapeLikeLiteral(literal: string): string {
  return literal.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Regex constructs we refuse to reason about — bail to bounded scan.
 * '(?'  — any (?...) group form: non-capturing (?:), lookahead (?=), negative
 *          lookahead (?!), lookbehind (?<=), negative lookbehind (?<!), and
 *          named capture (?<name>). We don't parse them, so we can't attribute
 *          their contents safely; bail to bounded scan (surfaced via scanLimited).
 * '|'   — alternation: no single literal is guaranteed across all branches.
 */
const UNSUPPORTED_CONSTRUCTS = ['(?', '|'];

function skipCharacterClass(source: string, openIndex: number): number {
  let i = openIndex + 1;
  if (source[i] === '^') {
    i += 1;
  }
  if (source[i] === ']') {
    i += 1; // leading ] is a literal member of the class
  }
  while (i < source.length && source[i] !== ']') {
    if (source[i] === '\\') {
      i += 1;
    }
    i += 1;
  }
  return i + 1; // past the closing ]
}

function skipBraceQuantifier(source: string, openIndex: number): number {
  let i = openIndex;
  while (i < source.length && source[i] !== '}') {
    i += 1;
  }
  return i + 1; // past the closing }
}

function longestRun(runs: string[]): string {
  let longest = '';
  for (const run of runs) {
    if (run.length > longest.length) {
      longest = run;
    }
  }
  return longest;
}

interface ScanState {
  current: string;
  runs: string[];
}

function endRun(state: ScanState): void {
  if (state.current.length > 0) {
    state.runs.push(state.current);
    state.current = '';
  }
}

function dropLastAndEndRun(state: ScanState): void {
  state.current = state.current.slice(0, -1);
  endRun(state);
}

/**
 * Consume the ENCODING characters of a backslash escape whose first char (after
 * `\`) is alphanumeric, returning the index just past the whole escape token.
 * Critical for soundness: the chars that ENCODE an escape are NOT literal text,
 * so they must never be collected into a run. `\x66` encodes `f` (1 char), not
 * the literal "x66"; collecting "66" would make a fixed-string prefilter look for
 * "66oo" and silently miss a line the JS RegExp matches as "foo".
 *
 * `i` points at the first char after the backslash (already known alphanumeric).
 * Returns the index of the first char AFTER the escape's encoding (where a NEW
 * literal run may legitimately begin, e.g. the `oo` in `\x66oo`).
 *
 * Class escapes (`\d \w \s \b …`) and single-digit backrefs encode no trailing
 * literal text, so they consume just the one char (the existing behaviour).
 */
const HEX_DIGIT = /[0-9a-fA-F]/;
const OCTAL_DIGIT = /[0-7]/;

/** Advance past up to `max` chars from `start` that match `pattern`; return the new index. */
function consumeWhile(source: string, start: number, max: number, pattern: RegExp): number {
  let j = start;
  let consumed = 0;
  while (j < source.length && consumed < max && pattern.test(source[j] ?? '')) {
    j += 1;
    consumed += 1;
  }
  return j;
}

/** Past the matching `}` of a `\u{…}` braced code-point escape. */
function skipBracedCodePoint(source: string, openBrace: number): number {
  let j = openBrace;
  while (j < source.length && source[j] !== '}') {
    j += 1;
  }
  return j + 1;
}

function skipEscapeEncoding(source: string, i: number): number {
  const marker = source[i] ?? '';
  if (marker === 'x') {
    return consumeWhile(source, i + 1, 2, HEX_DIGIT); // \xHH — up to two hex digits
  }
  if (marker === 'u') {
    return source[i + 1] === '{'
      ? skipBracedCodePoint(source, i + 1) // \u{H…}
      : consumeWhile(source, i + 1, 4, HEX_DIGIT); // \uHHHH
  }
  if (marker === 'c') {
    return i + 2; // \cX — a single control-letter
  }
  if (OCTAL_DIGIT.test(marker)) {
    return consumeWhile(source, i + 1, 2, OCTAL_DIGIT); // \0/\12/\123 — first digit + up to 2 more
  }
  // Class escape / word-boundary / backreference (\d \w \s \b \1 …): the marker
  // itself encodes no literal text; consume only it (the prior behaviour).
  return i + 1;
}

/** Returns the updated source position after consuming one logical token (may span multiple characters). */
function processToken(source: string, i: number, state: ScanState): number {
  const ch = source[i] ?? '';
  if (ch === '\\') {
    const next = source[i + 1] ?? '';
    if (/[a-zA-Z0-9]/.test(next)) {
      // An encoded/class escape — NOT a guaranteed literal. End the run, then skip
      // the ENTIRE escape token so its encoding chars (e.g. the `66` of `\x66`)
      // never leak into a literal and mislead the fixed-string prefilter.
      endRun(state);
      return skipEscapeEncoding(source, i + 1);
    }
    state.current += next; // escaped punctuation IS a literal character
    return i + 2;
  }
  if (ch === '[') {
    endRun(state);
    return skipCharacterClass(source, i);
  }
  if (ch === '?' || ch === '*') {
    dropLastAndEndRun(state); // preceding char is optional
    return i + 1;
  }
  if (ch === '{') {
    dropLastAndEndRun(state); // {0,..} may allow zero occurrences — be conservative
    return skipBraceQuantifier(source, i);
  }
  if (ch === '+') {
    endRun(state); // at least one occurrence — preceding char stays in the run
    return i + 1;
  }
  if (ch === '.' || ch === '^' || ch === '$' || ch === '(' || ch === ')') {
    endRun(state);
    return i + 1;
  }
  state.current += ch;
  return i + 1;
}

export function extractTrigramLiteral(source: string): string | null {
  for (const construct of UNSUPPORTED_CONSTRUCTS) {
    if (source.includes(construct)) {
      return null;
    }
  }
  // A `)` followed by an optionalizing quantifier makes every run inside that
  // group optional; attributing runs to groups needs a real parser. Bail.
  if (/\)[?*]|\)\{/.test(source)) {
    return null;
  }

  const state: ScanState = { current: '', runs: [] };
  let i = 0;
  while (i < source.length) {
    i = processToken(source, i, state);
  }
  endRun(state);

  const best = longestRun(state.runs);
  return best.length >= MIN_TRIGRAM_LITERAL_LENGTH ? best : null;
}
