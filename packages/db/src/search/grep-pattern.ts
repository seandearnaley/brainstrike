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

/** Regex constructs we refuse to reason about — bail to bounded scan. */
const UNSUPPORTED_CONSTRUCTS = ['|', '(?!', '(?<!'];

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

/** Returns the updated source position after consuming one logical token (may span multiple characters). */
function processToken(source: string, i: number, state: ScanState): number {
  const ch = source[i] ?? '';
  if (ch === '\\') {
    const next = source[i + 1] ?? '';
    if (/[a-zA-Z0-9]/.test(next)) {
      endRun(state); // class escape (\d \w \b \1 ...) — not a guaranteed literal
    } else {
      state.current += next; // escaped punctuation IS a literal character
    }
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

  const state: ScanState = { runs: [], current: '' };
  let i = 0;
  while (i < source.length) {
    i = processToken(source, i, state);
  }
  endRun(state);

  const best = longestRun(state.runs);
  return best.length >= MIN_TRIGRAM_LITERAL_LENGTH ? best : null;
}
