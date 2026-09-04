import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// BST-1322: the OpenAI-family vocabulary has one declaration, but deduplicating
// our copies did not connect that declaration to the provider it mirrors.
// @ai-sdk/openai 4.0.42 now ships an enumerable literal union in its chat-options
// declaration. A NARROWER app union hides accepted efforts; a WIDER one lets
// rejected values reach the wire. Both defects survive a green type-check.
//
// SCOPE, deliberately: union MEMBERSHIP and the claimed provider version for
// the platform `openai` provider's CHAT options only. The Responses-API field
// is an open `string`, not an oracle. OpenRouter's cross-vendor values and what
// any given model offers remain governed by resolveReasoningControlsAvailability.
const PROVIDER_PACKAGE = '@ai-sdk/openai';
const DECLARED_FILE = 'packages/types/src/assistant-provider-settings.ts';

function unique(values) {
  return [...new Set(values)].sort();
}

/** Reads literal union membership from the provider's shipped chat options. */
export function extractUpstreamEfforts(declarationSource) {
  const declarationStart = declarationSource.indexOf(
    'declare const openaiLanguageModelChatOptions:'
  );
  if (declarationStart === -1) {
    return [];
  }
  // End the slice at the declaration's OWN terminator (`}>;` closes the
  // LazySchema generic) rather than at the next `declare`: a dts bundle emits
  // plain `type`/`interface` declarations between `declare const`s, and one of
  // those carrying a same-indented `reasoningEffort` would otherwise be read as
  // the oracle after a future release drops the field from chat options.
  const declarationEnd = declarationSource.indexOf('}>;', declarationStart);
  const block = declarationSource.slice(
    declarationStart,
    declarationEnd === -1 ? undefined : declarationEnd + '}>;'.length
  );
  const effortDeclaration = /\n {4}reasoningEffort\?: (?<body>[^;]+);/u.exec(block);
  if (!effortDeclaration) {
    return [];
  }
  const members = effortDeclaration.groups.body.split('|').map((member) => member.trim());
  // Validate the WHOLE union: extracting just quoted substrings would accept
  // `"low" | string`, silently treating an open string as an enumerable oracle.
  if (members.some((member) => member !== 'undefined' && !/^"[^"\\]+"$/u.test(member))) {
    return [];
  }
  return unique(
    members.filter((member) => member !== 'undefined').map((member) => member.slice(1, -1))
  );
}

/** Reads the single declaration's membership and the provider versions it claims. */
export function extractDeclaredEfforts(source) {
  const declaration =
    /export const OPENAI_REASONING_EFFORT_VALUES = \[(?<body>[^\]]*)\] as const;/u.exec(source);
  return {
    annotatedVersions: unique(
      // Prerelease tags (`4.1.0-beta.1`) are real @ai-sdk versions; a bare
      // semver triple would reject the very annotation the violation asks for.
      [...source.matchAll(/@ai-sdk\/openai`?\s*\((?<version>\d+\.\d+\.\d+[^\s)]*)\)/gu)].map(
        (match) => match.groups.version
      )
    ),
    effort: unique(
      [...(declaration?.groups?.body ?? '').matchAll(/'(?<value>[^']+)'/gu)].map(
        (match) => match.groups.value
      )
    ),
  };
}

export function collectViolations({ installedVersion, declared, upstream }) {
  const violations = [];

  // Extraction failure must fail the lane, never pass vacuously. Do not compare
  // membership against an empty upstream set and misreport every value as WIDER.
  if (upstream.length === 0) {
    violations.push(
      `could not read the ${PROVIDER_PACKAGE} \`reasoningEffort\` enum from the installed chat-options declaration; the provider's declaration shape changed and this contract must be re-derived, not skipped`
    );
  } else {
    const missing = upstream.filter((value) => !declared.effort.includes(value));
    const extra = declared.effort.filter((value) => !upstream.includes(value));
    if (missing.length > 0) {
      violations.push(
        `${DECLARED_FILE} OPENAI_REASONING_EFFORT_VALUES is NARROWER than the installed ${PROVIDER_PACKAGE} \`reasoningEffort\` enum: missing ${missing.join(', ')}; the app would offer strictly less than the provider accepts`
      );
    }
    // The const also types OpenRouter's per-model `supportedEfforts`, so a
    // value the OpenAI chat schema no longer accepts is not automatically dead:
    // the violation names both resolutions instead of ordering a deletion.
    if (extra.length > 0) {
      violations.push(
        `${DECLARED_FILE} OPENAI_REASONING_EFFORT_VALUES is WIDER than the installed ${PROVIDER_PACKAGE} \`reasoningEffort\` enum: unknown ${extra.join(', ')}; the platform openai provider would type a value its wire rejects — drop it if no provider routes it, or split the OpenRouter vocabulary out of this const if OpenRouter still does`
      );
    }
  }
  // Deleting the annotation must not retire the version check silently when
  // the next provider bump requires a re-derivation.
  if (declared.annotatedVersions.length === 0) {
    violations.push(
      `${DECLARED_FILE} hand-mirrors ${PROVIDER_PACKAGE} but names no ${PROVIDER_PACKAGE} version; annotate the declaration \`(${installedVersion})\` so the next bump forces a re-derivation instead of passing silently`
    );
  }
  for (const annotated of declared.annotatedVersions) {
    if (annotated !== installedVersion) {
      violations.push(
        `${DECLARED_FILE} says it mirrors ${PROVIDER_PACKAGE} ${annotated} but ${installedVersion} is installed; re-derive the union from the installed declarations and correct the comment`
      );
    }
  }
  return violations;
}

function readActualState() {
  // Resolve through the actual consumer, packages/agent: pnpm's isolated layout
  // does not link this dependency at the root. Shipped dist/index.d.ts is what
  // tsc loads, so neither a manifest version literal nor provider src is evidence.
  const requireFromAgent = createRequire(path.join(repoRoot, 'packages/agent/package.json'));
  const manifestPath = requireFromAgent.resolve(`${PROVIDER_PACKAGE}/package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const declarations = readFileSync(
    path.join(path.dirname(manifestPath), 'dist/index.d.ts'),
    'utf8'
  );
  return {
    declared: extractDeclaredEfforts(readFileSync(path.join(repoRoot, DECLARED_FILE), 'utf8')),
    installedVersion: manifest.version,
    upstream: extractUpstreamEfforts(declarations),
  };
}

let cachedActualState;
function loadActualState() {
  cachedActualState ??= readActualState();
  return cachedActualState;
}

test('real tree: the OpenAI-family vocabulary matches the installed provider chat options', () => {
  assert.deepEqual(collectViolations(loadActualState()), []);
});

test('real tree: the upstream chat-options union is readable', () => {
  const { upstream } = loadActualState();
  // A floor, not the current exact count: additions should be reported by the
  // membership comparison, while a broken extractor cannot pass as an empty set.
  assert.ok(
    upstream.length >= 5,
    `expected at least five upstream efforts, found ${upstream.length}`
  );
});

test('extraction: Responses options alone are never mistaken for the chat oracle', () => {
  assert.deepEqual(
    extractUpstreamEfforts(`declare const openaiLanguageModelResponsesOptions: _ai_sdk_provider_utils.LazySchema<{
    reasoningEffort?: string | null | undefined;
}>;`),
    []
  );
});

test('money control: a declaration narrower than the provider fails visibly', () => {
  assert.deepEqual(
    collectViolations({
      declared: { annotatedVersions: ['4.0.42'], effort: ['high', 'low', 'medium'] },
      installedVersion: '4.0.42',
      upstream: ['high', 'low', 'medium', 'xhigh'],
    }),
    [
      'packages/types/src/assistant-provider-settings.ts OPENAI_REASONING_EFFORT_VALUES is NARROWER than the installed @ai-sdk/openai `reasoningEffort` enum: missing xhigh; the app would offer strictly less than the provider accepts',
    ]
  );
});

test('extraction: reads sorted unique literal efforts from chat options only', () => {
  assert.deepEqual(
    extractUpstreamEfforts(`declare const openaiLanguageModelChatOptions: _ai_sdk_provider_utils.LazySchema<{
    reasoningEffort?: "medium" | "low" | "low" | undefined;
}>;
declare const openaiLanguageModelResponsesOptions: _ai_sdk_provider_utils.LazySchema<{
    reasoningEffort?: string | null | undefined;
}>;`),
    ['low', 'medium']
  );
});

test('money control: a declaration wider than the provider fails visibly', () => {
  assert.deepEqual(
    collectViolations({
      declared: { annotatedVersions: ['4.0.42'], effort: ['high', 'low', 'medium', 'ultra'] },
      installedVersion: '4.0.42',
      upstream: ['high', 'low', 'medium'],
    }),
    [
      'packages/types/src/assistant-provider-settings.ts OPENAI_REASONING_EFFORT_VALUES is WIDER than the installed @ai-sdk/openai `reasoningEffort` enum: unknown ultra; the platform openai provider would type a value its wire rejects — drop it if no provider routes it, or split the OpenRouter vocabulary out of this const if OpenRouter still does',
    ]
  );
});

test('money control: a stale version annotation fails visibly', () => {
  assert.deepEqual(
    collectViolations({
      declared: { annotatedVersions: ['4.0.8'], effort: ['low', 'medium'] },
      installedVersion: '4.0.42',
      upstream: ['low', 'medium'],
    }),
    [
      'packages/types/src/assistant-provider-settings.ts says it mirrors @ai-sdk/openai 4.0.8 but 4.0.42 is installed; re-derive the union from the installed declarations and correct the comment',
    ]
  );
});

test('money control: unreadable upstream declarations fail instead of passing vacuously', () => {
  assert.deepEqual(
    collectViolations({
      declared: { annotatedVersions: ['4.0.42'], effort: ['low', 'medium'] },
      installedVersion: '4.0.42',
      upstream: [],
    }),
    [
      "could not read the @ai-sdk/openai `reasoningEffort` enum from the installed chat-options declaration; the provider's declaration shape changed and this contract must be re-derived, not skipped",
    ]
  );
});

test('money control: deleting the version annotation fails visibly', () => {
  assert.deepEqual(
    collectViolations({
      declared: { annotatedVersions: [], effort: ['low', 'medium'] },
      installedVersion: '4.0.42',
      upstream: ['low', 'medium'],
    }),
    [
      'packages/types/src/assistant-provider-settings.ts hand-mirrors @ai-sdk/openai but names no @ai-sdk/openai version; annotate the declaration `(4.0.42)` so the next bump forces a re-derivation instead of passing silently',
    ]
  );
});

test('extraction: a changed chat union cannot borrow an oracle from a later declaration', () => {
  // The literal in the later declaration deliberately looks valid. An extractor
  // that searches beyond the chat block must fail this control even if today's
  // Responses field is an open string and would happen to yield no literals.
  for (const field of [
    '',
    'reasoningEffort?: string | null | undefined;',
    'reasoningEffort?: "low" | string | undefined;',
    'reasoningEffort?: "low" | null | undefined;',
    'reasoningEffort?: undefined;',
  ]) {
    assert.deepEqual(
      extractUpstreamEfforts(`declare const openaiLanguageModelChatOptions: _ai_sdk_provider_utils.LazySchema<{
    ${field}
}>;
declare const otherOptions: _ai_sdk_provider_utils.LazySchema<{
    reasoningEffort?: "high" | "low" | undefined;
}>;`),
      [],
      `expected extraction failure for chat field: ${field}`
    );
  }
});

test('extraction: an interface between the chat options and the next declare cannot lend an oracle', () => {
  // No `\ndeclare ` separates the interface from the chat block, so a boundary
  // cut at the next `declare` would read the interface's field as the oracle.
  assert.deepEqual(
    extractUpstreamEfforts(`declare const openaiLanguageModelChatOptions: _ai_sdk_provider_utils.LazySchema<{
    user?: string | undefined;
}>;
interface OpenAIResponsesShape {
    reasoningEffort?: "high" | "low" | undefined;
}
declare const openaiLanguageModelResponsesOptions: _ai_sdk_provider_utils.LazySchema<{
    reasoningEffort?: string | null | undefined;
}>;`),
    []
  );
});

test('extraction: a prerelease provider version annotation is read whole', () => {
  assert.deepEqual(
    extractDeclaredEfforts(`/** Mirrors \`@ai-sdk/openai\` (4.1.0-beta.1). */
export const OPENAI_REASONING_EFFORT_VALUES = ['low'] as const;`).annotatedVersions,
    ['4.1.0-beta.1']
  );
});

test('extraction: reads the declared members and all distinct annotated versions', () => {
  assert.deepEqual(
    extractDeclaredEfforts(`/** Mirrors @ai-sdk/openai (4.0.42), \`@ai-sdk/openai\` (4.0.8),
 * @ai-sdk/openai (4.0.42), and @ai-sdk/anthropic (4.0.39). */
export const OPENAI_REASONING_EFFORT_VALUES = ['medium', 'low', 'low'] as const;`),
    { annotatedVersions: ['4.0.42', '4.0.8'], effort: ['low', 'medium'] }
  );
});

test('money control: a missing app declaration cannot retire the membership check', () => {
  assert.deepEqual(
    collectViolations({
      declared: extractDeclaredEfforts('// Mirrors @ai-sdk/openai (4.0.42).'),
      installedVersion: '4.0.42',
      upstream: ['low', 'medium'],
    }),
    [
      'packages/types/src/assistant-provider-settings.ts OPENAI_REASONING_EFFORT_VALUES is NARROWER than the installed @ai-sdk/openai `reasoningEffort` enum: missing low, medium; the app would offer strictly less than the provider accepts',
    ]
  );
});
