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
// values and the `thinking` discriminants — plus the version each mirror claims
// to mirror. It does NOT compare field optionality. `enabled.budgetTokens` is
// optional upstream and required in every mirror; that narrowing is intentional
// and predates this contract (it is identical in 4.0.8 and 4.0.39), so
// asserting it would fail the lane for a decision that was made on purpose.
const PROVIDER_PACKAGE = '@ai-sdk/anthropic';

// DISCOVERED, not hardcoded. A hardcoded list is the same drift this file
// exists to prevent, and it would already have been wrong on arrival: the
// BST-1310 review named the `packages/types` and `packages/assistant-contract`
// copies, and a third live mirror sits in `packages/agent/src/types.ts` — the
// package that actually hands `providerOptions` to the SDK. Sweeping every
// `packages/*/src` tree costs ~60ms over ~1.3k files and covers a fourth copy
// the day it lands.
function discoverMirrorFiles() {
  const found = [];
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
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) {
        continue;
      }
      const source = readFileSync(full, 'utf8');
      if (/export type Anthropic(?:Effort|ThinkingOptions) =/u.test(source)) {
        found.push({ file: path.relative(repoRoot, full), source });
      }
    }
  };
  for (const entry of readdirSync(path.join(repoRoot, 'packages'), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      walk(path.join(repoRoot, 'packages', entry.name, 'src'));
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file));
}

function unique(values) {
  return [...new Set(values)].sort();
}

/**
 * Reads the union membership out of the provider's shipped declarations.
 *
 * `dist/index.d.ts` is the right source rather than `src/`: it is what `tsc`
 * loads for our code, so it is the shape the mirrors are actually claiming to
 * match. Both properties are read out of the `anthropicLanguageModelOptions`
 * declaration specifically — `thinking` also appears further down the same file
 * as an unrelated `ZodRecord` on the raw request body.
 */
export function extractUpstreamUnions(declarationSource) {
  const declarationStart = declarationSource.indexOf(
    'declare const anthropicLanguageModelOptions:'
  );
  if (declarationStart === -1) {
    return { effort: [], thinkingTypes: [] };
  }
  const nextDeclaration = declarationSource.indexOf('\ndeclare ', declarationStart + 1);
  const block = declarationSource.slice(
    declarationStart,
    nextDeclaration === -1 ? undefined : nextDeclaration
  );
  const effortBlock = /\n {4}effort: z\.ZodOptional<z\.ZodEnum<\{(?<body>[\s\S]*?)\}>>;/u.exec(
    block
  );
  const thinkingBlock =
    /\n {4}thinking: z\.ZodOptional<z\.ZodDiscriminatedUnion<\[(?<body>[\s\S]*?)\]>>;/u.exec(block);
  return {
    effort: unique(
      [...(effortBlock?.groups?.body ?? '').matchAll(/: "(?<value>[^"]+)";/gu)].map(
        (match) => match.groups.value
      )
    ),
    thinkingTypes: unique(
      [
        ...(thinkingBlock?.groups?.body ?? '').matchAll(/type: z\.ZodLiteral<"(?<value>[^"]+)">/gu),
      ].map((match) => match.groups.value)
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
  if (mirrors.length === 0) {
    violations.push(
      `found no hand-mirrored ${PROVIDER_PACKAGE} unions under packages/*/src; if the mirrors genuinely moved, this contract needs rewriting around the new layout`
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
        annotatedVersions: ['4.0.8'],
        effort: ['high', 'low', 'max', 'medium', 'xhigh'],
        file: 'packages/types/src/assistant-provider-settings.ts',
        thinkingTypes: ['adaptive', 'disabled', 'enabled'],
      },
    ],
    upstream: {
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
        annotatedVersions: ['4.0.39'],
        effort: ['high', 'low', 'medium'],
        file: 'packages/agent/src/types.ts',
        thinkingTypes: ['adaptive', 'disabled', 'enabled'],
      },
    ],
    upstream: {
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
        annotatedVersions: ['4.0.39'],
        effort: ['high', 'low', 'max', 'medium', 'ultra', 'xhigh'],
        file: 'packages/agent/src/types.ts',
        thinkingTypes: ['adaptive', 'disabled', 'enabled'],
      },
    ],
    upstream: {
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
        annotatedVersions: ['4.0.39'],
        effort: ['high', 'low', 'max', 'medium', 'xhigh'],
        file: 'packages/assistant-contract/src/runtime-data.ts',
        thinkingTypes: ['enabled', 'disabled'],
      },
    ],
    upstream: {
      effort: ['high', 'low', 'max', 'medium', 'xhigh'],
      thinkingTypes: ['adaptive', 'disabled', 'enabled'],
    },
  });
  assert.match(violations.join('\n'), /AnthropicThinkingOptions is NARROWER .*missing adaptive/u);
});

test('money control: unreadable upstream declarations fail instead of passing vacuously', () => {
  const violations = collectViolations({
    installedVersion: '4.0.39',
    mirrors: [],
    upstream: { effort: [], thinkingTypes: [] },
  });
  assert.match(violations.join('\n'), /could not read the @ai-sdk\/anthropic `effort` enum/u);
  assert.match(violations.join('\n'), /could not read the @ai-sdk\/anthropic `thinking`/u);
  assert.match(violations.join('\n'), /found no hand-mirrored @ai-sdk\/anthropic unions/u);
});

test('extraction: reads the real provider declaration and the real mirrors', () => {
  // Guards the parsers themselves — a regex that silently stopped matching
  // would make every comparison above trivially true.
  const { installedVersion, mirrors, upstream } = loadActualState();
  assert.match(installedVersion, /^\d+\.\d+\.\d+$/u);
  assert.deepEqual(upstream.effort, ['high', 'low', 'max', 'medium', 'xhigh']);
  assert.deepEqual(upstream.thinkingTypes, ['adaptive', 'disabled', 'enabled']);
  const agentMirror = mirrors.find((mirror) => mirror.file === 'packages/agent/src/types.ts');
  assert.ok(agentMirror, 'expected the packages/agent mirror to be discovered');
  assert.deepEqual(agentMirror.effort, ['high', 'low', 'max', 'medium', 'xhigh']);
  assert.deepEqual(agentMirror.thinkingTypes, ['adaptive', 'disabled', 'enabled']);
  assert.deepEqual(agentMirror.annotatedVersions, [installedVersion]);
});
