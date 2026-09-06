import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// BST-1310: three packages hand-mirror the `effort` enum and the `thinking`
// discriminated union of `@ai-sdk/anthropic` as plain TypeScript unions, because
// the provider ships those shapes as zod schemas that it never exports as
// values — only `AnthropicLanguageModelOptions`, the inferred TYPE. So the
// unions cannot be re-exported; they are retyped by hand, and nothing connected
// them to the package they claim to mirror.
//
// That is a real defect class, not a hypothetical: PR #2462 moved the installed
// provider 4.0.8 -> 4.0.39 and all three mirrors kept a doc comment naming
// 4.0.8. The unions happened not to have changed, so the stale claim cost
// nothing that time. The next bump has no such guarantee — a mirror NARROWER
// than the provider makes the picker offer strictly less than the wire accepts
// (the exact bug the `xhigh`/`max` comment records), and a mirror WIDER lets a
// value the provider rejects reach the request boundary. Both fail at runtime,
// against a green type-check.
//
// SCOPE, deliberately: this contract compares union MEMBERSHIP — the effort
// values, the `thinking` discriminants, and the `thinking.adaptive.display`
// values — plus the version each mirror claims to mirror. It does NOT compare
// field optionality. `enabled.budgetTokens` is optional upstream and required in
// every mirror; that narrowing is intentional and predates this contract (it is
// identical in 4.0.8 and 4.0.39), so asserting it would fail the lane for a
// decision that was made on purpose. `display` is NOT covered by that exception:
// its optionality is ignored like every other field's, but its VALUES are
// compared, because both mirrors hand-copy `'omitted' | 'summarized'` and the
// app emits those at runtime — a release re-spelling them while leaving the
// `adaptive` discriminant alone would otherwise pass.
//
// 4.0.49 added a SECOND, undiscriminated member alongside the discriminated
// union: `{ type?: never; blockBinding: … }`, a shape that carries no `type`
// literal at all. It is outside this contract's scope by construction — there
// is no discriminant to compare — and the mirrors deliberately do not grow it
// here. Adopting `blockBinding` is a feature decision about what the app emits,
// not a drift this guard is entitled to force.
const PROVIDER_PACKAGE = '@ai-sdk/anthropic';
const MIRROR_ROOTS = ['apps', 'packages'];
const MIRROR_ROOT_LABEL = MIRROR_ROOTS.map((root) => `${root}/*/src`).join(' or ');

// DISCOVERED, not hardcoded. A hardcoded list is the same drift this file
// exists to prevent, and it would already have been wrong on arrival: the
// BST-1310 review named the `packages/types` and `packages/assistant-contract`
// copies, and a third live mirror sits in `packages/agent/src/types.ts` — the
// package that actually hands `providerOptions` to the SDK.
//
// The sweep is BOUNDED, and the bounds are worth stating so the `>= 3` floor
// below is not trusted further than it deserves:
//   - `apps/*/src` and `packages/*/src` only — nothing outside a workspace `src`
//     tree (`scripts/`, `docs/`, files at a package root).
//   - `.ts` and `.tsx`, excluding `.d.ts`.
//   - EXACT identifier match on `AnthropicEffort` / `AnthropicThinkingOptions`.
//     A copy named `AnthropicReasoningEffort` or `ClaudeThinkingOptions` is NOT
//     discovered, and the floor below would stay satisfied by the three known
//     mirrors while that fourth one drifted unchecked. Renaming or relocating a
//     mirror is therefore a deliberate act that has to be reflected here.
// Within those bounds a fourth copy is covered the day it lands; outside them it
// is not. The sweep costs ~60ms over ~1.6k files.
//
// `apps` is swept even though it holds no Anthropic mirror today, so that the
// bound is the sweep's rather than an accident of where mirrors happen to live.
// Two apps/packages declarations LOOK like candidates and are not:
// `apps/web/src/server/web-assistant-runtime-schema.ts` validates
// `requestedReasoningEffort`, typed `OpenAiReasoningEffort` — which
// `@brainstrike/types` owns, and whose values that file no longer spells out at
// all: its `z.enum` is derived from `OPENAI_REASONING_EFFORT_VALUES`, so there
// is no declaration there to mirror anything. (It used to hand-list the seven
// values including `none`/`minimal`, which the Anthropic enum lacks; that was
// the older disqualifier, and deduplicating it made the point moot.) The other
// is `EFFORT_TRACK_ORDER` in
// `packages/assistant-ui/src/reasoning-effort-controls.tsx`, a cross-provider
// display ordering rather than a wire union. Neither mirrors this provider.
export function sweepMirrorRoots() {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') {
          walk(full);
        }
        continue;
      }
      if (!/\.tsx?$/u.test(entry.name) || entry.name.endsWith('.d.ts')) {
        continue;
      }
      files.push(path.relative(repoRoot, full));
    }
  };
  for (const root of MIRROR_ROOTS) {
    for (const entry of readdirSync(path.join(repoRoot, root), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(repoRoot, root, entry.name, 'src'));
      }
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function discoverMirrorFiles() {
  const found = [];
  for (const file of sweepMirrorRoots()) {
    const source = readFileSync(path.join(repoRoot, file), 'utf8');
    if (/export type Anthropic(?:Effort|ThinkingOptions) =/u.test(source)) {
      found.push({ file, source });
    }
  }
  return found;
}

function unique(values) {
  return [...new Set(values)].sort();
}

const CLOSING_BRACKETS = new Map([
  ['<', '>'],
  ['[', ']'],
  ['{', '}'],
  ['(', ')'],
]);

/**
 * Whether the character at `index` closes the innermost open bracket.
 *
 * There is deliberately NO special case for the `>` of an arrow type, and the
 * reason is a proof rather than a measurement. An earlier version carried one
 * defensively, on the theory that `z.ZodType<() => void>` could pop the frame
 * `<` opened and truncate the slice.
 *
 * It cannot, at any call site in this file. Truncation requires the mis-pop to
 * EMPTY the stack, so the outermost opener handed to `sliceBalanced` would have
 * to be `<`. Every entry point opens a brace or a square bracket instead — the
 * options declaration, the discriminated union, each union member, and each
 * enum body. So an arrow's `>` can only pop an INNER `<` frame, after which the
 * type's own closing `>` matches nothing and is skipped, and the slice still
 * ends at the right outermost closer.
 *
 * That is why no fixture could be built that went red without the guard: it was
 * unreachable. It is removed rather than kept as code no test can exercise. If a
 * call site is ever added that opens with an angle bracket, this reasoning
 * expires with it.
 */
function isCloser(source, index, stack) {
  return stack.length > 0 && source[index] === stack.at(-1);
}

/**
 * The text inside the bracket that opens at `openIndex`, or `null` when the
 * source never balances.
 *
 * Anchored regexes stopped being able to read this declaration at 4.0.49:
 * `thinking` is no longer a bare `ZodDiscriminatedUnion` but a `ZodUnion`
 * wrapping one plus an undiscriminated sibling, so the union body sits two
 * bracket levels deeper and a lazy `[\s\S]*?` stops at whichever `]>>;` comes
 * first rather than at the matching one. A depth scan reads the real nesting;
 * `null` on an unbalanced source keeps the failure loud rather than handing
 * back a truncated slice that parses into a plausible-looking subset.
 *
 * Worth knowing when reading the rest of this file: a BRACKET mis-scan here is
 * LOUD. A corrupted slice makes `sliceAfter` return null or a body that
 * `topLevelFields` cannot parse, `thinkingTypes` comes back empty, and the
 * pinned real-tree assertions fail with "must be re-derived, not skipped".
 *
 * That is a claim about UNBALANCED input, and it does not extend to every kind
 * of mis-scan — an earlier version of this comment said "there is no path where
 * a bad scan quietly narrows the answer", which was wrong. A brace inside a
 * string literal (`z.ZodLiteral<"a{b">`) desynchronises this stack, and while
 * that particular case is loud, the SILENT ones came from the comment stripper,
 * which is why it is quote-aware. These scanners are still string-unaware; the
 * protection against that is that an unbalanced result fails the pinned
 * assertions, not that it cannot happen.
 */
function sliceBalanced(source, openIndex) {
  const stack = [];
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    const closing = CLOSING_BRACKETS.get(char);
    if (closing !== undefined) {
      stack.push(closing);
      continue;
    }
    if (isCloser(source, index, stack)) {
      stack.pop();
      if (stack.length === 0) {
        return source.slice(openIndex + 1, index);
      }
    }
  }
  return null;
}

/**
 * Block comments are stripped before any scanning. A `<`, `[` or unpaired
 * bracket inside a JSDoc block — `{@link <https://…>}` is the ordinary way this
 * shows up — desynchronizes the bracket stack, and the same text breaks
 * `topLevelFields`, which requires each `;`-separated chunk to start with an
 * identifier and so drops any field a comment precedes. Generated zod-inference
 * types carry no JSDoc today; this removes the whole class rather than relying
 * on that staying true.
 */
function stripBlockComments(source) {
  // Line comments are stripped per line, and ONLY outside a string literal.
  // A blanket /\/\/[^\n]*/ deletes real declaration text the moment a literal
  // contains `//` — a URL-valued enum member is the ordinary way that happens.
  // `b: "https://x"; c: z.ZodString;` would become `b: "https:` with the
  // terminating `;` eaten, merging two fields into one chunk and dropping the
  // second from topLevelFields with no signal. Brackets stay balanced through
  // that, so nothing downstream notices: it is silent narrowing, which is the
  // class this whole contract exists to prevent.
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//gu, '');
  return withoutBlocks
    .split('\n')
    .map((line) => {
      let quote = null;
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (quote) {
          if (char === '\\') {
            index += 1;
          } else if (char === quote) {
            quote = null;
          }
          continue;
        }
        if (char === '"' || char === "'" || char === '`') {
          quote = char;
          continue;
        }
        if (char === '/' && line[index + 1] === '/') {
          return line.slice(0, index);
        }
      }
      return line;
    })
    .join('\n');
}

/** The balanced body of the first `bracket` that follows `marker`. */
function sliceAfter(source, marker, bracket) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) {
    return null;
  }
  const openIndex = source.indexOf(bracket, markerIndex + marker.length);
  return openIndex === -1 ? null : sliceBalanced(source, openIndex);
}

/**
 * Splits on `separator` occurrences sitting at bracket depth 0.
 *
 * This is what lets the extractor talk about a declaration's OWN members:
 * `anthropicLanguageModelOptions` nests a second `thinking` field inside
 * `fallbacks`, and the `adaptive` variant nests a `blockBinding` object, so a
 * flat scan would fold those into the top-level answer.
 */
function splitTopLevel(source, separator) {
  const parts = [];
  const stack = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const closing = CLOSING_BRACKETS.get(char);
    if (closing !== undefined) {
      stack.push(closing);
      continue;
    }
    if (isCloser(source, index, stack)) {
      stack.pop();
      continue;
    }
    if (stack.length === 0 && char === separator) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

/** The `name -> type expression` pairs declared directly in a `{…}` type body. */
function topLevelFields(objectBody) {
  const fields = new Map();
  for (const declaration of splitTopLevel(objectBody, ';')) {
    const named = /^\s*(?<name>[A-Za-z_$][\w$]*)\??:(?<type>[\s\S]*)$/u.exec(declaration);
    if (named) {
      fields.set(named.groups.name, named.groups.type);
    }
  }
  return fields;
}

/**
 * The literal values of a `z.ZodEnum<{…}>` type expression.
 *
 * Tolerates a `ZodOptional` (or any other) wrapper on purpose: this contract
 * compares VALUES, never optionality.
 */
function extractZodEnumValues(typeExpression) {
  // EVERY `z.ZodEnum<` in the expression, not just the first. Reading one would
  // report a NARROWER upstream set than reality if a value union is ever spelled
  // as `z.ZodUnion<[z.ZodEnum<…>, z.ZodEnum<…>]>` — and a mirror that is
  // genuinely narrower than the provider would then compare clean. That is this
  // contract's own bug class, inverted. The pinned assertions catch it for
  // today's shape, but those are exactly what gets edited during an upgrade.
  const values = [];
  let cursor = 0;
  for (;;) {
    const found = typeExpression.indexOf('z.ZodEnum<', cursor);
    if (found === -1) {
      break;
    }
    const body = sliceAfter(typeExpression.slice(found), 'z.ZodEnum<', '{');
    if (body !== null) {
      values.push(
        ...[...body.matchAll(/: "(?<value>[^"]+)"/gu)].map((match) => match.groups.value)
      );
    }
    cursor = found + 'z.ZodEnum<'.length;
  }
  return unique(values);
}

/**
 * The top-level fields of each member of the `thinking` discriminated union.
 *
 * Reads the `ZodDiscriminatedUnion` specifically rather than the whole
 * `thinking` expression, so the undiscriminated `blockBinding`-only sibling
 * 4.0.49 added is not mistaken for a variant, and so the `display` compared
 * below is unambiguously the `adaptive` one — a future release adding a
 * same-named field to another variant must not silently merge into that set.
 */
function extractUpstreamThinkingVariants(thinkingType) {
  const unionMembers = sliceAfter(thinkingType, 'z.ZodDiscriminatedUnion<', '[');
  if (unionMembers === null) {
    return [];
  }
  return splitTopLevel(unionMembers, ',')
    .map((member) => sliceAfter(member, 'z.ZodObject<', '{'))
    .filter((body) => body !== null)
    .map((body) => topLevelFields(body));
}

/** The `type: z.ZodLiteral<"…">` discriminant of one union variant, if it has one. */
function readDiscriminant(variantFields) {
  const literal = /^\s*z\.ZodLiteral<"(?<value>[^"]+)">\s*$/u.exec(variantFields.get('type') ?? '');
  return literal?.groups?.value ?? null;
}

/**
 * The `display` values of a mirror's `adaptive` member.
 *
 * Matched as a whole variant object so field ORDER does not matter, and so a
 * `display` on a different member is not mistaken for this one. A mirror that
 * drops `display` entirely yields `[]`, which reads as NARROWER — the drift we
 * want reported, not an extraction failure.
 */
function extractMirrorAdaptiveDisplay(thinkingBody) {
  const adaptiveVariant = [...thinkingBody.matchAll(/\{(?<body>[^{}]*)\}/gu)]
    .map((match) => match.groups.body)
    .find((body) => /type: 'adaptive'/u.test(body));
  if (adaptiveVariant === undefined) {
    return [];
  }
  const displayField = /display\??:(?<body>[^;]*)/u.exec(adaptiveVariant);
  return unique(
    [...(displayField?.groups?.body ?? '').matchAll(/'(?<value>[^']+)'/gu)].map(
      (match) => match.groups.value
    )
  );
}

/**
 * Reads the union membership out of the provider's shipped declarations.
 *
 * `dist/index.d.ts` is the right source rather than `src/`: it is what `tsc`
 * loads for our code, so it is the shape the mirrors are actually claiming to
 * match. Both properties are read out of the `anthropicLanguageModelOptions`
 * declaration specifically, and out of its OWN top-level fields — `thinking`
 * appears again inside that declaration's `fallbacks` entry as a `ZodRecord`,
 * and again further down the file on the raw request body.
 */
export function extractUpstreamUnions(rawDeclarationSource) {
  const declarationSource = stripBlockComments(rawDeclarationSource);
  const optionsBody = sliceAfter(
    declarationSource,
    'declare const anthropicLanguageModelOptions:',
    '{'
  );
  if (optionsBody === null) {
    return {
      adaptiveDisplay: [],
      adaptiveFieldCount: 0,
      effort: [],
      fieldCount: 0,
      thinkingTypes: [],
    };
  }
  const fields = topLevelFields(optionsBody);
  const variants = extractUpstreamThinkingVariants(fields.get('thinking') ?? '');
  const adaptive = variants.find((variant) => readDiscriminant(variant) === 'adaptive');
  return {
    adaptiveDisplay: extractZodEnumValues(adaptive?.get('display') ?? ''),
    adaptiveFieldCount: adaptive?.size ?? 0,
    effort: extractZodEnumValues(fields.get('effort') ?? ''),
    fieldCount: fields.size,
    thinkingTypes: unique(
      variants.map((variant) => readDiscriminant(variant)).filter((value) => value !== null)
    ),
  };
}

/** Reads one mirror's union membership and the provider version it claims. */
export function extractMirror(file, source) {
  const effortDeclaration = /export type AnthropicEffort =(?<body>[^;]*);/u.exec(source);
  const thinkingDeclaration = /export type AnthropicThinkingOptions =(?<body>[\s\S]*?);\n/u.exec(
    source
  );
  return {
    adaptiveDisplay: thinkingDeclaration
      ? extractMirrorAdaptiveDisplay(thinkingDeclaration.groups.body)
      : null,
    annotatedVersions: unique(
      [...source.matchAll(/@ai-sdk\/anthropic`?\s*\((?<version>\d+\.\d+\.\d+)\)/gu)].map(
        (match) => match.groups.version
      )
    ),
    effort: effortDeclaration
      ? unique(
          [...effortDeclaration.groups.body.matchAll(/'(?<value>[^']+)'/gu)].map(
            (match) => match.groups.value
          )
        )
      : null,
    file,
    thinkingTypes: thinkingDeclaration
      ? unique(
          [...thinkingDeclaration.groups.body.matchAll(/type: '(?<value>[^']+)'/gu)].map(
            (match) => match.groups.value
          )
        )
      : null,
  };
}

export function collectViolations({ installedVersion, mirrors, upstream }) {
  const violations = [];

  // Extraction failure must fail the lane, never pass vacuously: an upstream
  // refactor that renames the declaration would otherwise leave every
  // comparison trivially satisfied against an empty set.
  if (upstream.effort.length === 0) {
    violations.push(
      `could not read the ${PROVIDER_PACKAGE} \`effort\` enum from the installed declarations; the provider's declaration shape changed and this contract must be re-derived, not skipped`
    );
  }
  if (upstream.thinkingTypes.length === 0) {
    violations.push(
      `could not read the ${PROVIDER_PACKAGE} \`thinking\` discriminated union from the installed declarations; the provider's declaration shape changed and this contract must be re-derived, not skipped`
    );
  }
  // Only meaningful while `adaptive` exists upstream. If the discriminant is
  // gone the `thinking` comparison already reports it; if it is present but the
  // nested enum cannot be read, the shape changed and this must be re-derived.
  if (upstream.thinkingTypes.includes('adaptive') && upstream.adaptiveDisplay.length === 0) {
    violations.push(
      `could not read the ${PROVIDER_PACKAGE} \`thinking.adaptive.display\` enum from the installed declarations even though the \`adaptive\` variant is present; the provider's declaration shape changed and this contract must be re-derived, not skipped`
    );
  }
  if (mirrors.length === 0) {
    violations.push(
      `found no hand-mirrored ${PROVIDER_PACKAGE} unions under ${MIRROR_ROOT_LABEL}; if the mirrors genuinely moved, this contract needs rewriting around the new layout`
    );
  }

  for (const mirror of mirrors) {
    if (mirror.effort && upstream.effort.length > 0) {
      assertSameMembers({
        actual: mirror.effort,
        expected: upstream.effort,
        file: mirror.file,
        typeName: 'AnthropicEffort',
        unionName: '`effort` enum',
        violations,
      });
    }
    if (mirror.thinkingTypes && upstream.thinkingTypes.length > 0) {
      assertSameMembers({
        actual: mirror.thinkingTypes,
        expected: upstream.thinkingTypes,
        file: mirror.file,
        typeName: 'AnthropicThinkingOptions',
        unionName: '`thinking` discriminated union',
        violations,
      });
    }
    if (mirror.adaptiveDisplay && upstream.adaptiveDisplay.length > 0) {
      assertSameMembers({
        actual: mirror.adaptiveDisplay,
        expected: upstream.adaptiveDisplay,
        file: mirror.file,
        typeName: 'AnthropicThinkingOptions adaptive.display',
        unionName: '`thinking.adaptive.display` enum',
        violations,
      });
    }
    // An EMPTY annotation list is a violation, not a pass. Iterating alone
    // meant the version half of this contract could be retired for a file by
    // deleting a comment — and deleting the comment is the cheapest way to
    // green the lane the next time a bump reports staleness, which is exactly
    // when the re-derivation is most needed.
    if (mirror.annotatedVersions.length === 0) {
      violations.push(
        `${mirror.file} hand-mirrors ${PROVIDER_PACKAGE} but names no ${PROVIDER_PACKAGE} version; annotate the declaration \`(${installedVersion})\` so the next bump forces a re-derivation instead of passing silently`
      );
    }
    for (const annotated of mirror.annotatedVersions) {
      if (annotated !== installedVersion) {
        violations.push(
          `${mirror.file} says it mirrors ${PROVIDER_PACKAGE} ${annotated} but ${installedVersion} is installed; re-derive the union from the installed declarations and correct the comment`
        );
      }
    }
  }

  return violations;
}

function assertSameMembers({ actual, expected, file, typeName, unionName, violations }) {
  const missing = expected.filter((value) => !actual.includes(value));
  const extra = actual.filter((value) => !expected.includes(value));
  if (missing.length > 0) {
    violations.push(
      `${file} ${typeName} is NARROWER than the installed ${PROVIDER_PACKAGE} ${unionName}: missing ${missing.join(', ')}; the app would offer strictly less than the provider accepts`
    );
  }
  if (extra.length > 0) {
    violations.push(
      `${file} ${typeName} is WIDER than the installed ${PROVIDER_PACKAGE} ${unionName}: unknown ${extra.join(', ')}; those values would reach the request boundary and be rejected at runtime`
    );
  }
}

function readActualState() {
  // Resolved through packages/agent because the provider is that package's
  // dependency, not the repo root's — pnpm's isolated layout gives the root no
  // link to it. This also makes the assertion about the tree that is really
  // installed rather than about a version literal in a manifest.
  const requireFromAgent = createRequire(path.join(repoRoot, 'packages/agent/package.json'));
  const manifestPath = requireFromAgent.resolve(`${PROVIDER_PACKAGE}/package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const declarations = readFileSync(
    path.join(path.dirname(manifestPath), 'dist/index.d.ts'),
    'utf8'
  );
  return {
    installedVersion: manifest.version,
    mirrors: discoverMirrorFiles().map(({ file, source }) => extractMirror(file, source)),
    upstream: extractUpstreamUnions(declarations),
  };
}

let cachedActualState;
function loadActualState() {
  cachedActualState ??= readActualState();
  return cachedActualState;
}

test('real tree: every hand-mirrored @ai-sdk/anthropic union matches the installed provider', () => {
  assert.deepEqual(collectViolations(loadActualState()), []);
});

test('real tree: the mirrors are discovered, and both unions are readable upstream', () => {
  const { mirrors, upstream } = loadActualState();
  // A floor, not an exact count, so adding a legitimate fourth mirror does not
  // fail the lane — but silently discovering ZERO (a moved package, a changed
  // declaration keyword) cannot masquerade as a pass.
  assert.ok(
    mirrors.length >= 3,
    `expected at least the three known mirrors, found ${mirrors.length}: ${mirrors.map((mirror) => mirror.file).join(', ')}`
  );
  assert.ok(upstream.effort.length > 0, 'expected to read the upstream effort enum');
  assert.ok(upstream.thinkingTypes.length > 0, 'expected to read the upstream thinking union');
});

test('money control: the pre-BST-1310 stale version annotation fails visibly', () => {
  const violations = collectViolations({
    installedVersion: '4.0.39',
    mirrors: [
      {
        adaptiveDisplay: ['omitted', 'summarized'],
        annotatedVersions: ['4.0.8'],
        effort: ['high', 'low', 'max', 'medium', 'xhigh'],
        file: 'packages/types/src/assistant-provider-settings.ts',
        thinkingTypes: ['adaptive', 'disabled', 'enabled'],
      },
    ],
    upstream: {
      adaptiveDisplay: ['omitted', 'summarized'],
      effort: ['high', 'low', 'max', 'medium', 'xhigh'],
      thinkingTypes: ['adaptive', 'disabled', 'enabled'],
    },
  });
  assert.match(violations.join('\n'), /says it mirrors @ai-sdk\/anthropic 4\.0\.8 but 4\.0\.39/u);
});

test('money control: a mirror narrower than the provider fails visibly', () => {
  // This replays the original `xhigh`/`max` bug the mirror comment records.
  const violations = collectViolations({
    installedVersion: '4.0.39',
    mirrors: [
      {
        adaptiveDisplay: ['omitted', 'summarized'],
        annotatedVersions: ['4.0.39'],
        effort: ['high', 'low', 'medium'],
        file: 'packages/agent/src/types.ts',
        thinkingTypes: ['adaptive', 'disabled', 'enabled'],
      },
    ],
    upstream: {
      adaptiveDisplay: ['omitted', 'summarized'],
      effort: ['high', 'low', 'max', 'medium', 'xhigh'],
      thinkingTypes: ['adaptive', 'disabled', 'enabled'],
    },
  });
  assert.match(violations.join('\n'), /is NARROWER than the installed .*missing max, xhigh/u);
});

test('money control: a mirror wider than the provider fails visibly', () => {
  const violations = collectViolations({
    installedVersion: '4.0.39',
    mirrors: [
      {
        adaptiveDisplay: ['omitted', 'summarized'],
        annotatedVersions: ['4.0.39'],
        effort: ['high', 'low', 'max', 'medium', 'ultra', 'xhigh'],
        file: 'packages/agent/src/types.ts',
        thinkingTypes: ['adaptive', 'disabled', 'enabled'],
      },
    ],
    upstream: {
      adaptiveDisplay: ['omitted', 'summarized'],
      effort: ['high', 'low', 'max', 'medium', 'xhigh'],
      thinkingTypes: ['adaptive', 'disabled', 'enabled'],
    },
  });
  assert.match(violations.join('\n'), /is WIDER than the installed .*unknown ultra/u);
});

test('money control: a dropped thinking discriminant fails visibly', () => {
  const violations = collectViolations({
    installedVersion: '4.0.39',
    mirrors: [
      {
        adaptiveDisplay: ['omitted', 'summarized'],
        annotatedVersions: ['4.0.39'],
        effort: ['high', 'low', 'max', 'medium', 'xhigh'],
        file: 'packages/assistant-contract/src/runtime-data.ts',
        thinkingTypes: ['enabled', 'disabled'],
      },
    ],
    upstream: {
      adaptiveDisplay: ['omitted', 'summarized'],
      effort: ['high', 'low', 'max', 'medium', 'xhigh'],
      thinkingTypes: ['adaptive', 'disabled', 'enabled'],
    },
  });
  assert.match(violations.join('\n'), /AnthropicThinkingOptions is NARROWER .*missing adaptive/u);
});

// The version half is the one an author is most likely to "fix" by REMOVAL.
// The next bump turns this lane red with "says it mirrors 4.0.39 but 4.0.53 is
// installed"; deleting the `(4.0.39)` is cheaper than re-deriving the union and
// would otherwise retire the drift check for that file forever, silently.
test('money control: a mirror that names no provider version fails visibly', () => {
  const violations = collectViolations({
    installedVersion: '4.0.39',
    mirrors: [
      {
        adaptiveDisplay: ['omitted', 'summarized'],
        annotatedVersions: [],
        effort: ['high', 'low', 'max', 'medium', 'xhigh'],
        file: 'packages/agent/src/types.ts',
        thinkingTypes: ['adaptive', 'disabled', 'enabled'],
      },
    ],
    upstream: {
      adaptiveDisplay: ['omitted', 'summarized'],
      effort: ['high', 'low', 'max', 'medium', 'xhigh'],
      thinkingTypes: ['adaptive', 'disabled', 'enabled'],
    },
  });
  assert.match(violations.join('\n'), /names no @ai-sdk\/anthropic version/u);
});

test('money control: a drifted thinking.adaptive.display union fails visibly', () => {
  const violations = collectViolations({
    installedVersion: '4.0.39',
    mirrors: [
      {
        adaptiveDisplay: ['omitted'],
        annotatedVersions: ['4.0.39'],
        effort: ['high', 'low', 'max', 'medium', 'xhigh'],
        file: 'packages/agent/src/types.ts',
        thinkingTypes: ['adaptive', 'disabled', 'enabled'],
      },
    ],
    upstream: {
      adaptiveDisplay: ['omitted', 'summarized'],
      effort: ['high', 'low', 'max', 'medium', 'xhigh'],
      thinkingTypes: ['adaptive', 'disabled', 'enabled'],
    },
  });
  assert.match(violations.join('\n'), /adaptive\.display` enum: missing summarized/u);
});

test('money control: an unreadable adaptive.display enum fails instead of passing vacuously', () => {
  const violations = collectViolations({
    installedVersion: '4.0.39',
    mirrors: [
      {
        adaptiveDisplay: ['omitted', 'summarized'],
        annotatedVersions: ['4.0.39'],
        effort: ['high', 'low', 'max', 'medium', 'xhigh'],
        file: 'packages/agent/src/types.ts',
        thinkingTypes: ['adaptive', 'disabled', 'enabled'],
      },
    ],
    upstream: {
      adaptiveDisplay: [],
      effort: ['high', 'low', 'max', 'medium', 'xhigh'],
      thinkingTypes: ['adaptive', 'disabled', 'enabled'],
    },
  });
  assert.match(
    violations.join('\n'),
    /could not read the @ai-sdk\/anthropic `thinking\.adaptive\.display`/u
  );
});

test('money control: unreadable upstream declarations fail instead of passing vacuously', () => {
  const violations = collectViolations({
    installedVersion: '4.0.39',
    mirrors: [],
    upstream: { adaptiveDisplay: [], effort: [], thinkingTypes: [] },
  });
  assert.match(violations.join('\n'), /could not read the @ai-sdk\/anthropic `effort` enum/u);
  assert.match(violations.join('\n'), /could not read the @ai-sdk\/anthropic `thinking`/u);
  assert.match(violations.join('\n'), /found no hand-mirrored @ai-sdk\/anthropic unions/u);
});

// A synthetic declaration in the 4.0.49 shape, so the comment stripping below
// is exercised on input that actually contains what it guards against. The real
// dist/index.d.ts carries no JSDoc today, so without this the stripping would be
// unfalsifiable — removing it leaves every real-tree case green, which is not
// evidence of anything.
function syntheticDeclaration({ jsdoc = '', urlField = '', splitEnum = false } = {}) {
  const effort = splitEnum
    ? 'z.ZodOptional<z.ZodUnion<[z.ZodEnum<{ low: "low" }>, z.ZodEnum<{ medium: "medium"; high: "high" }>]>>'
    : 'z.ZodOptional<z.ZodEnum<{ low: "low"; medium: "medium"; high: "high" }>>';
  return `declare const anthropicLanguageModelOptions: z.ZodObject<{
	effort: ${effort};${urlField}${jsdoc}
	thinking: z.ZodOptional<z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
		type: z.ZodLiteral<"adaptive">;
		display: z.ZodOptional<z.ZodEnum<{ omitted: "omitted"; summarized: "summarized" }>>;
	}, $strip>, z.ZodObject<{ type: z.ZodLiteral<"disabled">; }, $strip>]>, z.ZodObject<{
		type: z.ZodOptional<z.ZodNever>;
	}, $strip>]>>;
}, $strip>;
`;
}

test('scanner: a `//` inside a string literal does not eat the rest of the field', () => {
  // The silent case, and the reason the line stripper is quote-aware. A blanket
  // /\/\/[^\n]*/ turns `docs: "https://x";` into `docs: "https:` — the
  // terminating `;` goes with it, `splitTopLevel` then sees ONE chunk spanning
  // two fields, and `topLevelFields` keeps the first and drops the second with
  // no signal. Brackets stay balanced throughout, so nothing downstream notices.
  const documented = extractUpstreamUnions(
    syntheticDeclaration({ urlField: '\n\tdocs: z.ZodLiteral<"https://example.invalid/a">;' })
  );
  assert.deepEqual(documented.effort, ['high', 'low', 'medium']);
  assert.deepEqual(documented.thinkingTypes, ['adaptive', 'disabled']);
  assert.deepEqual(documented.adaptiveDisplay, ['omitted', 'summarized']);
});

test('scanner: a value union spelled as two enums reports BOTH sets', () => {
  // Reading only the first `z.ZodEnum<` would report `['low']` — a NARROWER
  // upstream than reality, against which a genuinely narrow mirror compares
  // clean. That is this contract's own bug class, inverted.
  const split = extractUpstreamUnions(syntheticDeclaration({ splitEnum: true }));
  assert.deepEqual(split.effort, ['high', 'low', 'medium']);
});

test('scanner: a JSDoc block inside the declaration body does not blind the scan', () => {
  // Measured: without stripBlockComments this returns effort=[] and
  // thinkingTypes=[], because the unpaired `{` and `<` desynchronize the bracket
  // stack and topLevelFields then sees no identifier-led chunk. Loud, but it
  // would refuse a legitimate upstream release that merely documented a field.
  const documented = extractUpstreamUnions(
    syntheticDeclaration({ jsdoc: '\n\t/** doc { unpaired and <https://example.invalid/a[b> */' })
  );
  assert.deepEqual(documented.thinkingTypes, ['adaptive', 'disabled']);
  assert.deepEqual(documented.adaptiveDisplay, ['omitted', 'summarized']);
  assert.deepEqual(documented.effort, ['high', 'low', 'medium']);
  // The undocumented form reads identically — stripping changes nothing else.
  assert.deepEqual(extractUpstreamUnions(syntheticDeclaration()), documented);
});

test('extraction: reads the real provider declaration and the real mirrors', () => {
  // Guards the parsers themselves — a regex that silently stopped matching
  // would make every comparison above trivially true.
  const { installedVersion, mirrors, upstream } = loadActualState();
  assert.match(installedVersion, /^\d+\.\d+\.\d+$/u);
  // A floor on the field map itself. topLevelFields drops any `;`-separated
  // chunk that does not start with an identifier, which is right for index
  // signatures and stray text but means a `readonly`-prefixed or quoted member
  // vanishes with no signal. The pinned unions below catch a drop of `effort` or
  // `thinking`; this catches a scan that quietly collapsed to a handful of
  // fields while those two happened to survive.
  // The adaptive variant's OWN fields, not just the declaration's. Variant
  // extraction reads the first `z.ZodObject<` per union member, so an upstream
  // that ever expresses a variant as an intersection or `.extend()` chain would
  // emit two objects and the second's fields — a `display` that moved there
  // included — would be dropped in silence. The declaration-level floor below
  // cannot see that; this can.
  assert.ok(
    upstream.adaptiveFieldCount >= 2,
    `expected the adaptive variant to expose at least type and display, read ${upstream.adaptiveFieldCount}`
  );
  assert.ok(
    upstream.fieldCount >= 5,
    `expected the options declaration to expose several top-level fields, read ${upstream.fieldCount}`
  );
  assert.deepEqual(upstream.effort, ['high', 'low', 'max', 'medium', 'xhigh']);
  assert.deepEqual(upstream.thinkingTypes, ['adaptive', 'disabled', 'enabled']);
  assert.deepEqual(upstream.adaptiveDisplay, ['omitted', 'summarized', 'updates']);
  const agentMirror = mirrors.find((mirror) => mirror.file === 'packages/agent/src/types.ts');
  assert.ok(agentMirror, 'expected the packages/agent mirror to be discovered');
  assert.deepEqual(agentMirror.effort, ['high', 'low', 'max', 'medium', 'xhigh']);
  assert.deepEqual(agentMirror.thinkingTypes, ['adaptive', 'disabled', 'enabled']);
  assert.deepEqual(agentMirror.adaptiveDisplay, ['omitted', 'summarized', 'updates']);
  assert.deepEqual(agentMirror.annotatedVersions, [installedVersion]);
});

test('real tree: the sweep really reaches apps/*/src and .tsx files', () => {
  // Guards the two bounds this PR widened. Asserting the walk directly rather
  // than the mirror list, because today there is no Anthropic mirror in `apps`
  // or in a `.tsx` file — so a silent reversion would leave every other
  // assertion in this file green.
  const swept = sweepMirrorRoots();
  assert.ok(
    swept.some((file) => file.startsWith('apps/web/src/')),
    'expected the sweep to reach apps/web/src'
  );
  assert.ok(
    swept.some((file) => file.endsWith('.tsx')),
    'expected the sweep to reach .tsx files'
  );
});
