/**
 * BST-1939: trigram candidate plans for native grep. A plan is a boolean
 * formula of ASCII literals (3+ characters) that every chunk holding a
 * matching line must contain, so a trigram FTS index can select candidates
 * before the authoritative line matcher (`createGrepLineMatcher`) verifies
 * them. The plan never decides a match; it may only widen to "scan".
 *
 * Soundness rests on three facts about the matcher and SQLite's trigram index:
 * - Regex matching never uses the `u`/`v` flags, so under `i` an ASCII pattern
 *   character only matches ASCII (ES Canonicalize keeps non-ASCII characters
 *   from folding to ASCII). Case-sensitive matches are exact.
 * - Literal case-insensitive matching lowercases the line, and only U+0130 and
 *   U+212A lowercase to ASCII (`i`, `k`); those letters never join a literal.
 * - The `trigram` tokenizer folds ASCII case and indexes every character, so a
 *   chunk containing an ASCII substring has all of its trigrams in order.
 *
 * The regex analysis follows Russ Cox's trigram index (each node's emptyable,
 * exact, prefix, suffix and match), with whole literals instead of trigrams:
 * https://swtch.com/~rsc/regexp/regexp4.html
 */
import { type AST, RegExpParser, RegExpSyntaxError } from '@eslint-community/regexpp';

export type GrepTrigramQuery =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'and' | 'or'; readonly terms: readonly GrepTrigramQuery[] };

export type GrepTrigramPlan =
  | {
      readonly kind: 'candidates';
      /** The FTS5 MATCH expression for the trigram table. */
      readonly match: string;
      readonly query: GrepTrigramQuery;
    }
  | {
      readonly kind: 'scan';
      /** No required literal, or regex syntax the planner cannot read; results stay exact. */
      readonly reason: 'unconstrained' | 'unsupported-syntax';
    };

/** The shortest literal a trigram query can require. */
const MIN_LITERAL = 3;
/** Longer required literals are cut to a required prefix. */
const MAX_LITERAL = 64;
const EXACT_LIMIT = 16;
const SET_LIMIT = 16;
const OR_LIMIT = 32;
const TERM_LIMIT = 64;
/** ASCII letters some non-ASCII character lowercases to (U+0130, U+212A). */
const LOWERCASE_FOLD_TARGETS = new Set(['i', 'k']);

/** `undefined` stands for "no constraint" while analysing. */
type Query = GrepTrigramQuery | undefined;

interface Info {
  readonly emptyable: boolean;
  /** Every string the node matches, lowercased, or null when not small and known. */
  readonly exact: ReadonlySet<string> | null;
  /** Literals every match contains. */
  readonly match: Query;
  /** Possible prefixes and suffixes of a match; meaningful only when `exact` is null. */
  readonly prefix: ReadonlySet<string>;
  readonly suffix: ReadonlySet<string>;
}

const NONE: ReadonlySet<string> = new Set(['']);

function emptyString(): Info {
  return { emptyable: true, exact: new Set(['']), match: undefined, prefix: NONE, suffix: NONE };
}

function anyCharacter(): Info {
  return { emptyable: false, exact: null, match: undefined, prefix: NONE, suffix: NONE };
}

function anyString(): Info {
  return { emptyable: true, exact: null, match: undefined, prefix: NONE, suffix: NONE };
}

/** A printable ASCII code unit, case-folded the way the trigram index folds it. */
function indexable(code: number): string | undefined {
  return code >= 0x20 && code <= 0x7e ? String.fromCharCode(code).toLowerCase() : undefined;
}

function terms(query: Query, kind: 'and' | 'or'): readonly GrepTrigramQuery[] {
  if (query === undefined) {
    return [];
  }
  return query.kind === kind ? query.terms : [query];
}

function key(query: GrepTrigramQuery): string {
  return JSON.stringify(query);
}

function combine(kind: 'and' | 'or', parts: readonly GrepTrigramQuery[]): Query {
  const unique = [...new Map(parts.map((part) => [key(part), part])).values()];
  if (unique.length === 0) {
    return;
  }
  return unique.length === 1 ? unique[0] : { kind, terms: unique };
}

function and(left: Query, right: Query): Query {
  return combine('and', [...terms(left, 'and'), ...terms(right, 'and')]);
}

function or(left: Query, right: Query): Query {
  // Either side unconstrained leaves the disjunction unconstrained.
  if (left === undefined || right === undefined) {
    return;
  }
  const parts = [...terms(left, 'or'), ...terms(right, 'or')];
  return parts.length > OR_LIMIT ? undefined : combine('or', parts);
}

/** A string set as "contains one of these"; any short member leaves it unconstrained. */
function anyOf(strings: ReadonlySet<string>): Query {
  const values = [...strings];
  if (values.length === 0 || values.some((value) => value.length < MIN_LITERAL)) {
    return;
  }
  const cut = [...new Set(values.map((value) => value.slice(0, MAX_LITERAL)))];
  // Containing a longer member implies containing any member inside it.
  const minimal = cut.filter(
    (value) => !cut.some((other) => other !== value && value.includes(other))
  );
  if (minimal.length > OR_LIMIT) {
    return;
  }
  return combine(
    'or',
    minimal.map((value) => ({ kind: 'literal', value }))
  );
}

function cross(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  const product = new Set<string>();
  for (const a of left) {
    for (const b of right) {
      product.add(a + b);
    }
  }
  return product;
}

function union(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  return new Set([...left, ...right]);
}

function minLength(strings: ReadonlySet<string>): number {
  return Math.min(...[...strings].map((value) => value.length));
}

/** Shortens a prefix (or suffix) set until it is small; shortening only widens it. */
function boundSet(strings: ReadonlySet<string>, side: 'prefix' | 'suffix'): ReadonlySet<string> {
  const cut = (value: string, length: number): string =>
    side === 'prefix' ? value.slice(0, length) : value.slice(Math.max(0, value.length - length));
  let bounded = new Set([...strings].map((value) => cut(value, MAX_LITERAL)));
  if (bounded.size > SET_LIMIT) {
    bounded = new Set([...bounded].map((value) => cut(value, MIN_LITERAL - 1)));
  }
  if (bounded.size > SET_LIMIT || bounded.has('')) {
    return NONE;
  }
  const values = [...bounded];
  return new Set(
    values.filter(
      (value) =>
        !values.some(
          (other) =>
            other !== value && (side === 'prefix' ? value.startsWith(other) : value.endsWith(other))
        )
    )
  );
}

/** Moves a large or long exact set into the match and the prefix/suffix sets. */
function simplify(info: Info): Info {
  const { exact } = info;
  if (exact === null) {
    return {
      ...info,
      prefix: boundSet(info.prefix, 'prefix'),
      suffix: boundSet(info.suffix, 'suffix'),
    };
  }
  if (exact.size <= EXACT_LIMIT && [...exact].every((value) => value.length <= MAX_LITERAL)) {
    return info;
  }
  return {
    emptyable: info.emptyable,
    exact: null,
    match: and(info.match, anyOf(exact)),
    prefix: boundSet(exact, 'prefix'),
    suffix: boundSet(exact, 'suffix'),
  };
}

function concat(x: Info, y: Info): Info {
  let match = and(x.match, y.match);
  if (x.exact !== null && y.exact !== null) {
    return simplify({
      emptyable: x.emptyable && y.emptyable,
      exact: cross(x.exact, y.exact),
      match,
      prefix: NONE,
      suffix: NONE,
    });
  }
  // At most one side is exact here; an exact side's strings are its own affixes.
  let prefix: ReadonlySet<string>;
  if (x.exact === null) {
    prefix = x.emptyable ? union(x.prefix, y.exact ?? y.prefix) : x.prefix;
  } else {
    prefix = cross(x.exact, y.prefix);
  }
  let suffix: ReadonlySet<string>;
  if (y.exact === null) {
    suffix = y.emptyable ? union(y.suffix, x.exact ?? x.suffix) : y.suffix;
  } else {
    suffix = cross(x.suffix, y.exact);
  }
  // A literal spanning the boundary appears in neither side's own sets.
  if (
    x.exact === null &&
    y.exact === null &&
    x.suffix.size <= SET_LIMIT &&
    y.prefix.size <= SET_LIMIT &&
    minLength(x.suffix) + minLength(y.prefix) >= MIN_LITERAL
  ) {
    match = and(match, anyOf(cross(x.suffix, y.prefix)));
  }
  return simplify({ emptyable: x.emptyable && y.emptyable, exact: null, match, prefix, suffix });
}

/** An exact node's strings as prefixes and suffixes, its literals in the match. */
function inexact(info: Info): Info {
  if (info.exact === null) {
    return info;
  }
  return {
    emptyable: info.emptyable,
    exact: null,
    match: and(info.match, anyOf(info.exact)),
    prefix: info.exact,
    suffix: info.exact,
  };
}

function alternate(x: Info, y: Info): Info {
  const emptyable = x.emptyable || y.emptyable;
  if (x.exact !== null && y.exact !== null) {
    return simplify({
      emptyable,
      exact: union(x.exact, y.exact),
      match: or(x.match, y.match),
      prefix: NONE,
      suffix: NONE,
    });
  }
  const left = inexact(x);
  const right = inexact(y);
  return simplify({
    emptyable,
    exact: null,
    match: or(left.match, right.match),
    prefix: union(left.prefix, right.prefix),
    suffix: union(left.suffix, right.suffix),
  });
}

function characterClass(node: AST.CharacterClass): Info {
  if (node.negate) {
    return anyCharacter();
  }
  const members = new Set<string>();
  for (const element of node.elements) {
    if (element.type === 'Character') {
      const value = indexable(element.value);
      if (value === undefined) {
        return anyCharacter();
      }
      members.add(value);
      continue;
    }
    if (
      element.type !== 'CharacterClassRange' ||
      element.max.value - element.min.value >= SET_LIMIT
    ) {
      return anyCharacter();
    }
    for (let code = element.min.value; code <= element.max.value; code += 1) {
      const value = indexable(code);
      if (value === undefined) {
        return anyCharacter();
      }
      members.add(value);
    }
  }
  return members.size === 0 || members.size > SET_LIMIT
    ? anyCharacter()
    : simplify({ emptyable: false, exact: members, match: undefined, prefix: NONE, suffix: NONE });
}

function quantifier(node: AST.Quantifier): Info {
  if (node.max === 0) {
    return emptyString();
  }
  const element = analyse(node.element);
  if (node.min === 0) {
    return node.max === 1 ? alternate(element, emptyString()) : anyString();
  }
  if (node.min === node.max && node.min <= 4) {
    let repeated = element;
    for (let count = 1; count < node.min; count += 1) {
      repeated = concat(repeated, element);
    }
    return repeated;
  }
  // x{n,m} with n >= 1 starts with an x, ends with one, and contains one.
  return simplify(inexact(element));
}

function alternatives(nodes: readonly AST.Alternative[]): Info {
  return nodes
    .map((alternative) =>
      alternative.elements.reduce((info, node) => concat(info, analyse(node)), emptyString())
    )
    .reduce(alternate);
}

function analyse(node: AST.Element): Info {
  switch (node.type) {
    case 'Character': {
      const value = indexable(node.value);
      return value === undefined
        ? anyCharacter()
        : {
            emptyable: false,
            exact: new Set([value]),
            match: undefined,
            prefix: NONE,
            suffix: NONE,
          };
    }
    case 'CharacterClass':
      return characterClass(node);
    case 'CharacterSet':
    case 'ExpressionCharacterClass':
      return anyCharacter();
    // Zero-width: a match without the assertion's restriction is a superset.
    case 'Assertion':
      return emptyString();
    // The referenced text is unknown, and empty when its group did not take part.
    case 'Backreference':
      return anyString();
    case 'CapturingGroup':
    case 'Group':
      return alternatives(node.alternatives);
    case 'Quantifier':
      return quantifier(node);
    default:
      return anyString();
  }
}

/** Keeps whole conjuncts, longest literals first, within the term budget. */
function bounded(query: Query): Query {
  const count = (part: GrepTrigramQuery): number =>
    part.kind === 'literal' ? 1 : part.terms.reduce((total, term) => total + count(term), 0);
  const weight = (part: GrepTrigramQuery): number =>
    part.kind === 'literal' ? part.value.length : 0;
  let budget = TERM_LIMIT;
  const kept: GrepTrigramQuery[] = [];
  for (const part of [...terms(query, 'and')].sort((a, b) => weight(b) - weight(a))) {
    const cost = count(part);
    if (cost <= budget) {
      kept.push(part);
      budget -= cost;
    }
  }
  return combine('and', kept);
}

function regexQuery(pattern: string): Query | 'unsupported-syntax' {
  let parsed: AST.Pattern;
  try {
    // The matcher compiles `new RegExp(pattern, '' | 'i')`: Annex B, no u/v flag.
    parsed = new RegExpParser({ ecmaVersion: 2025, strict: false }).parsePattern(
      pattern,
      0,
      pattern.length,
      { unicode: false, unicodeSets: false }
    );
  } catch (error) {
    if (error instanceof RegExpSyntaxError) {
      return 'unsupported-syntax';
    }
    throw error;
  }
  const info = alternatives(parsed.alternatives);
  return info.exact === null
    ? and(info.match, and(anyOf(info.prefix), anyOf(info.suffix)))
    : and(info.match, anyOf(info.exact));
}

/** Maximal runs of indexable characters the literal matcher requires verbatim. */
function literalQuery(pattern: string, caseSensitive: boolean): Query {
  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  const runs: string[] = [];
  let run = '';
  for (let index = 0; index < needle.length; index += 1) {
    const value = indexable(needle.charCodeAt(index));
    if (value === undefined || (!caseSensitive && LOWERCASE_FOLD_TARGETS.has(value))) {
      runs.push(run);
      run = '';
      continue;
    }
    run += value;
  }
  runs.push(run);
  return runs
    .filter((value) => value.length >= MIN_LITERAL)
    .reduce<Query>((query, value) => and(query, anyOf(new Set([value]))), undefined);
}

function matchExpression(query: GrepTrigramQuery): string {
  if (query.kind === 'literal') {
    return `"${query.value.replaceAll('"', '""')}"`;
  }
  return `(${query.terms.map(matchExpression).join(query.kind === 'and' ? ' AND ' : ' OR ')})`;
}

/** The candidate plan for one grep request, as `createGrepLineMatcher` will match it. */
export function planGrepTrigramCandidates(
  pattern: string,
  isRegex: boolean,
  caseSensitive: boolean
): GrepTrigramPlan {
  const query = isRegex ? regexQuery(pattern) : literalQuery(pattern, caseSensitive);
  if (query === 'unsupported-syntax') {
    return { kind: 'scan', reason: 'unsupported-syntax' };
  }
  const limited = bounded(query);
  return limited === undefined
    ? { kind: 'scan', reason: 'unconstrained' }
    : { kind: 'candidates', match: matchExpression(limited), query: limited };
}
