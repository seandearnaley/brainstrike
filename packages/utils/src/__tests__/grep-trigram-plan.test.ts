import recorded from '@brainstrike/test-utils/fixtures/recorded-grep-patterns.json' with {
  type: 'json',
};
import { describe, expect, it } from 'vitest';
import { createGrepLineMatcher } from '../grep-line-matcher.js';
import { type GrepTrigramQuery, planGrepTrigramCandidates } from '../grep-trigram-plan.js';

/** The weakest folding a trigram index may apply: ASCII letters only. */
function asciiFold(text: string): string {
  return text.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
}

function satisfies(query: GrepTrigramQuery, line: string): boolean {
  switch (query.kind) {
    case 'literal':
      return asciiFold(line).includes(query.value);
    case 'and':
      return query.terms.every((term) => satisfies(term, line));
    case 'or':
      return query.terms.some((term) => satisfies(term, line));
    default:
      return false;
  }
}

/** Deterministic PRNG (mulberry32) so failures reproduce. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d_2b_79_f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Planner soundness: every line the canonical matcher accepts satisfies the plan. */
function expectSound(
  pattern: string,
  isRegex: boolean,
  caseSensitive: boolean,
  lines: readonly string[]
): void {
  let matcher: ReturnType<typeof createGrepLineMatcher>;
  try {
    matcher = createGrepLineMatcher(pattern, isRegex, caseSensitive);
  } catch {
    // The real grep refuses this pattern before any plan is used.
    return;
  }
  const plan = planGrepTrigramCandidates(pattern, isRegex, caseSensitive);
  if (plan.kind === 'scan') {
    return;
  }
  for (const line of lines) {
    if (matcher.matches(line) && !satisfies(plan.query, line)) {
      throw new Error(
        `Unsound plan ${plan.match} for ${JSON.stringify(pattern)} (regex ${isRegex}, case ${caseSensitive}) on ${JSON.stringify(line)}`
      );
    }
  }
}

describe('engine facts the planner relies on', () => {
  it('lowercases only U+0130 and U+212A from non-ASCII into ASCII', () => {
    const folding: string[] = [];
    for (let code = 0x80; code <= 0x10_ff_ff; code += 1) {
      if (code >= 0xd8_00 && code <= 0xdf_ff) {
        continue;
      }
      const ascii = [...String.fromCodePoint(code).toLowerCase()].filter(
        (character) => character.charCodeAt(0) < 0x80
      );
      if (ascii.length > 0) {
        folding.push(`${code.toString(16)}:${ascii.join('')}`);
      }
    }
    expect(folding).toEqual(['130:i', '212a:k']);
  });

  it('never matches a non-ASCII code unit with an ASCII character under a non-unicode i flag', () => {
    const ascii = /[ -~]/i;
    const matched: number[] = [];
    for (let code = 0x80; code <= 0xff_ff; code += 1) {
      if (ascii.test(String.fromCharCode(code))) {
        matched.push(code);
      }
    }
    expect(matched).toEqual([]);
  });
});

describe('planGrepTrigramCandidates', () => {
  it.each([
    ['needle', false, true, '"needle"'],
    ['say "hi" now', false, true, '"say ""hi"" now"'],
    [
      'workspace indexing startup',
      false,
      false,
      '("ng startup" AND "space " AND "ndex" AND "wor")',
    ],
    ['foo(bar|baz)', true, true, '("foobar" OR "foobaz")'],
    ['(?<=x)abc\\b', true, true, '"abc"'],
    ['^export function \\w+Plan', true, false, '("export function " AND "plan")'],
    ['abc+', true, true, '"abc"'],
    ['[Rr]eserve\\(', true, true, '"reserve("'],
  ])('plans %j (regex %s, case %s) as %s', (pattern, isRegex, caseSensitive, match) => {
    expect(planGrepTrigramCandidates(pattern, isRegex, caseSensitive)).toMatchObject({
      kind: 'candidates',
      match,
    });
  });

  it.each([
    ['ab', false],
    ['.*', true],
    ['\\w+\\s\\d', true],
    ['a.b.c', true],
    ['(abc)?', true],
    ['\\1abc|x', true],
    ['漢字テスト', false],
    ['ki', false],
  ])('scans every chunk for %j (regex %s)', (pattern, isRegex) => {
    expect(planGrepTrigramCandidates(pattern, isRegex, true)).toEqual({
      kind: 'scan',
      reason: 'unconstrained',
    });
  });

  it('cuts long literals and keeps the conjunction within its term budget', () => {
    const plan = planGrepTrigramCandidates(
      Array.from({ length: 100 }, (_, index) => `w${index}xyz`).join('é'),
      false,
      true
    );
    expect(plan.kind).toBe('candidates');
    expect(plan.kind === 'candidates' && plan.query.kind === 'and' && plan.query.terms.length).toBe(
      64
    );
    const long = planGrepTrigramCandidates('x'.repeat(10_000), false, true);
    expect(long).toMatchObject({ match: `"${'x'.repeat(64)}"` });
  });

  it('is sound for every recorded code-search pattern over lines built from its own words', () => {
    const next = random(1939);
    const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)] as T;
    const noise = ['', ' ', '\t', '.', '(', 'é', 'İ', 'K', '_', 'X', '😀', '\u0000', '"'];
    for (const { caseInsensitive, pattern } of recorded.patterns) {
      const words = pattern.split(/[^A-Za-z0-9_]+/u).filter(Boolean);
      const lines: string[] = [];
      for (let index = 0; index < 24; index += 1) {
        const parts = Array.from({ length: 1 + Math.floor(next() * 4) }, () => {
          const word = words.length > 0 ? pick(words) : 'x';
          const cased = next() < 0.3 ? word.toUpperCase() : word;
          return `${pick(noise)}${cased}${pick(noise)}`;
        });
        lines.push(parts.join(pick([' ', '.', '(', '', '::'])));
      }
      lines.push(pattern, pattern.toUpperCase(), pattern.replace(/\\(.)/gu, '$1'));
      expectSound(pattern, true, !caseInsensitive, lines);
      expectSound(pattern, false, true, lines);
      expectSound(pattern, false, false, lines);
    }
  });

  it('is sound for generated regexes over a small mixed-case and non-ASCII alphabet', () => {
    const next = random(42);
    const alphabet = ['a', 'b', 'c', 'A', 'B', 'K', 'k', 'i', 'I', 'é', 'İ', 'K', ' '];
    const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)] as T;
    const atom = (depth: number): string => {
      const roll = next();
      if (depth > 3 || roll < 0.4) {
        return pick([
          ...alphabet.filter((value) => value !== ' '),
          '.',
          '[ab]',
          '[a-c]',
          '[^a]',
          '\\w',
          '\\s',
        ]);
      }
      if (roll < 0.55) {
        return `(${regex(depth + 1)})`;
      }
      if (roll < 0.65) {
        return `(?:${regex(depth + 1)}|${regex(depth + 1)})`;
      }
      if (roll < 0.72) {
        return pick(['^', '$', '\\b', '\\B', '(?=a)', '(?!b)', '(?<=c)', '(?<!a)']);
      }
      return `${atom(depth + 1)}${pick(['*', '+', '?', '{2}', '{1,3}', '{0,2}', '{3,}'])}`;
    };
    const regex = (depth: number): string => {
      const length = 1 + Math.floor(next() * 5);
      const sequence = Array.from({ length }, () => atom(depth)).join('');
      return next() < 0.15 ? `${sequence}|${atom(depth)}` : sequence;
    };
    const lines = Array.from({ length: 400 }, () =>
      Array.from({ length: 2 + Math.floor(next() * 14) }, () => pick(alphabet)).join('')
    );
    for (let index = 0; index < 2500; index += 1) {
      const pattern = regex(0);
      const local = [
        ...lines,
        ...Array.from({ length: 8 }, () => pattern.replace(/[^\p{L} ]/gu, '')),
      ];
      expectSound(pattern, true, true, local);
      expectSound(pattern, true, false, local);
      expectSound(pattern, false, true, local);
      expectSound(pattern, false, false, local);
    }
  });
});
