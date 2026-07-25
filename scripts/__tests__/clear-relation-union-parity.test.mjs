import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Diffs the two hand-maintained clear/reset relation unions and requires every
 * divergence to be declared here with a reason.
 *
 * WHY THIS EXISTS: both clear paths PROBE with `to_regclass` before deleting,
 * which is what stops a missing relation from aborting the enclosing transaction
 * (see the FACTORY RESET CONTRACT in docs/agents/platform-contracts.md). The
 * cost of probing is that the table name can no longer be wrong-but-loud: a
 * stale or missing name returns NULL, indistinguishable from "table absent", so
 * it becomes a PERMANENT SILENT SKIP. The closed literal unions
 * (`OptionalRelationTable` desktop-side, `ClearableRelation` renderer-side) are
 * what carry that guarantee instead of the runtime.
 *
 * But the guarantee STOPS AT THE UNION BOUNDARY. They are two separate
 * hand-maintained lists with no shared source, so a table added to one side and
 * forgotten on the other type-checks cleanly on both and clears on only one
 * platform — exactly the "latent, not absent" failure class the probe conversion
 * set out to eliminate. Nothing else in the repo compares them (raised in review
 * on PR #1986).
 *
 * They are deliberately NOT derived from one exported runtime array. The
 * renderer module cannot safely import cross-package table constants — see
 * mastra-workflow-table-literal-contract.test.mjs for the measured renderer
 * crash that caused. A source-parsing guard has the same effect with no runtime
 * import edge.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const DESKTOP_SOURCE = path.join(repoRoot, 'apps/desktop/src/ipc-domains/db-ipc.ts');
const RENDERER_SOURCE = path.join(repoRoot, 'packages/db/src/db-provider.tsx');
const CONTRACT_SOURCE = path.join(
  repoRoot,
  'packages/assistant-contract/src/mastra-memory-schema.ts'
);

/**
 * Resolves a `typeof X` union member to its string value.
 *
 * The two sides name the Mastra workflow table DIFFERENTLY on purpose, so this
 * has to handle both: desktop main IMPORTS `MASTRA_WORKFLOW_TABLE` from the
 * contract package, while the renderer keeps a local literal because that import
 * reorders bundle chunk init and kills the app at startup (measured on
 * `3e8d1b7fd`; see mastra-workflow-table-literal-contract.test.mjs, which pins
 * the literal). Resolving both to the actual string is what makes the diff below
 * comparable.
 */
function resolveConstant(source, sourcePath, name) {
  const local = source.match(new RegExp(`\\b${name}\\s*=\\s*'([^']+)'`, 'u'));
  if (local) {
    return local[1];
  }

  const contract = readFileSync(CONTRACT_SOURCE, 'utf8');
  const exported = contract.match(
    new RegExp(`export const ${name}\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*;`, 'u')
  );
  assert.ok(
    exported,
    `"${name}" is neither a local literal in ${path.relative(repoRoot, sourcePath)} nor an ` +
      `export of ${path.relative(repoRoot, CONTRACT_SOURCE)}. Teach this guard where it lives.`
  );
  const backing = contract.match(new RegExp(`const ${exported[1]}\\s*=\\s*'([^']+)'`, 'u'));
  assert.ok(
    backing,
    `Found ${name} = ${exported[1]} in the contract, but no "const ${exported[1]} = '<name>'" ` +
      'backing it.'
  );
  return backing[1];
}

/**
 * Divergences that are currently ACCEPTED, each with the reason it is accepted.
 *
 * These are NOT all "intentional by design" — `reason` says which. A known gap
 * recorded here is a gap someone chose to leave with their eyes open; an
 * undeclared one is a gap nobody noticed. Adding an entry is a deliberate act
 * that shows up in review; that is the whole point.
 */
const ACCEPTED_DIVERGENCES = [
  {
    reason:
      'INTENTIONAL. Required table, never optional: both platforms delete it UNWRAPPED in the ' +
      'clear path (they SELECT COUNT(*) from it first, which would throw anyway if absent). It ' +
      'is in the renderer union only because the renderer additionally has a table-by-table ' +
      'factory-reset purge (`purgeTablesTx`). Desktop factory reset has no SQL equivalent — ' +
      '`resetLocalDatabase` rmSyncs the whole profile directory (apps/desktop/src/db-main.ts).',
    side: 'renderer-only',
    table: 'file_chunks',
  },
  {
    reason:
      'INTENTIONAL. Same as file_chunks: required table deleted unwrapped in both clear paths, ' +
      'present in the renderer union only for the renderer-only `purgeTablesTx` factory-reset ' +
      'purge, which desktop implements by deleting the profile directory instead.',
    side: 'renderer-only',
    table: 'file_records',
  },
  {
    reason:
      'KNOWN GAP, not intentional. Migration 046. `packages/app-shell` is SHARED code and ' +
      'INSERTs into it (assistant-memory-repository.ts), so per-thread token/cost history ' +
      'survives a web clear/reset — a FACTORY RESET CONTRACT violation. Widening renderer ' +
      'coverage is a behavioural change needing its own real-PGlite proof; tracked separately.',
    side: 'desktop-only',
    table: 'brainstrike_assistant_run_usage',
  },
  {
    reason:
      'KNOWN GAP, not intentional. Migration 055. Also written by SHARED `packages/app-shell` ' +
      'code, so assistant-ui branch topology survives a web clear/reset. Same tracking as ' +
      'brainstrike_assistant_run_usage.',
    side: 'desktop-only',
    table: 'brainstrike_assistant_message_parents',
  },
  {
    reason:
      'KNOWN GAP, currently latent. Only desktop-side writers today ' +
      '(apps/desktop/src/assistant-server/task-list-repository.ts), so nothing writes it on ' +
      'web yet. Becomes live the moment a shared writer appears.',
    side: 'desktop-only',
    table: 'brainstrike_assistant_task_lists',
  },
  {
    reason:
      'KNOWN GAP, currently latent. Rows are written by desktop-side journal/revert modules; ' +
      'shared app-shell code only reads and deletes. Becomes live if a shared writer appears.',
    side: 'desktop-only',
    table: 'brainstrike_assistant_edit_checkpoints',
  },
];

/**
 * Extracts the string members of a `type <Name> = 'a' | 'b' | typeof X;` union.
 * `typeof X` members are resolved through the `const X = '<literal>'` in the same
 * file, which is how both unions name the Mastra workflow table.
 */
function readUnionMembers(sourcePath, typeName) {
  const source = readFileSync(sourcePath, 'utf8');
  const declaration = source.match(new RegExp(`type ${typeName} =([^;]+);`, 'u'));
  assert.ok(
    declaration,
    `Could not find "type ${typeName} = …;" in ${path.relative(repoRoot, sourcePath)}. ` +
      'If the union moved or was renamed, teach this guard the new shape rather than deleting it.'
  );

  return declaration[1]
    .split('|')
    .map((member) => member.trim())
    .filter(Boolean)
    .map((member) => {
      const literal = member.match(/^'([^']+)'$/u);
      if (literal) {
        return literal[1];
      }
      const typeofRef = member.match(/^typeof\s+([A-Za-z_$][\w$]*)$/u);
      assert.ok(typeofRef, `Unsupported member "${member}" in ${typeName}. Teach this guard it.`);
      return resolveConstant(source, sourcePath, typeofRef[1]);
    });
}

function describeDivergence({ side, table }) {
  return `${side}: ${table}`;
}

test('every clear-union divergence between desktop and renderer is declared', () => {
  const desktop = new Set(readUnionMembers(DESKTOP_SOURCE, 'OptionalRelationTable'));
  const renderer = new Set(readUnionMembers(RENDERER_SOURCE, 'ClearableRelation'));

  assert.ok(desktop.size > 0 && renderer.size > 0, 'Both unions must be non-empty.');

  const actual = [
    ...[...desktop]
      .filter((table) => !renderer.has(table))
      .map((table) => ({ side: 'desktop-only', table })),
    ...[...renderer]
      .filter((table) => !desktop.has(table))
      .map((table) => ({ side: 'renderer-only', table })),
  ];

  const declared = new Set(ACCEPTED_DIVERGENCES.map(describeDivergence));
  const undeclared = actual.filter((entry) => !declared.has(describeDivergence(entry)));

  assert.deepEqual(
    undeclared.map(describeDivergence),
    [],
    'A relation is cleared on one platform but not the other, and the divergence is not ' +
      'declared in ACCEPTED_DIVERGENCES. Because both paths PROBE with to_regclass, the ' +
      'missing side fails SILENTLY — no error, no warn, only a logger.debug — so the data ' +
      'simply survives a factory reset on that platform. Either add the table to the other ' +
      "union's clear path, or add an ACCEPTED_DIVERGENCES entry stating why it is acceptable."
  );
});

test('no ACCEPTED_DIVERGENCES entry is stale', () => {
  const desktop = new Set(readUnionMembers(DESKTOP_SOURCE, 'OptionalRelationTable'));
  const renderer = new Set(readUnionMembers(RENDERER_SOURCE, 'ClearableRelation'));

  // A guard whose allowlist outlives the problem quietly stops guarding. If a
  // divergence is closed, its entry must go too.
  const stale = ACCEPTED_DIVERGENCES.filter(({ side, table }) =>
    side === 'desktop-only'
      ? !(desktop.has(table) && !renderer.has(table))
      : !(renderer.has(table) && !desktop.has(table))
  );

  assert.deepEqual(
    stale.map(describeDivergence),
    [],
    'These ACCEPTED_DIVERGENCES entries no longer describe a real divergence — the table is ' +
      'now cleared on both sides (or on neither). Delete the entry so the allowlist keeps ' +
      'meaning what it says.'
  );
});

test('each ACCEPTED_DIVERGENCES entry carries a substantive reason', () => {
  for (const entry of ACCEPTED_DIVERGENCES) {
    assert.ok(
      typeof entry.reason === 'string' && entry.reason.length >= 40,
      `ACCEPTED_DIVERGENCES entry for ${describeDivergence(entry)} needs a real reason, not a ` +
        'placeholder. An allowlist without reasons is just a suppression.'
    );
  }
});
