import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Pins both clear/reset relation unions to their REGISTRY-DERIVED shape
 * (BST-992).
 *
 * HISTORY: this guard originally diffed two hand-maintained literal unions
 * (`OptionalRelationTable` desktop-side, `ClearableRelation` renderer-side)
 * and required every divergence to carry a written reason, because the probe
 * conversion (#1986) made a name missing from one side a PERMANENT SILENT
 * SKIP: `to_regclass` returns NULL for a stale name, indistinguishable from
 * "table absent". Its allowlist recorded four KNOWN-GAP tables (BST-862) that
 * desktop cleared and web did not.
 *
 * BST-992 closed those gaps and replaced the two hand-maintained lists with
 * ONE source of truth: `packages/db/src/reset-table-registry.ts`. Set parity
 * is now enforced by strictly stronger instruments —
 *
 *   - both unions DERIVE from the registry's `ResetTable` (a hand-typo is a
 *     type error, not a silent skip);
 *   - registry↔call-site set-equality tests cover all three reset paths
 *     (`packages/db/__tests__/reset-table-registry.test.tsx`, the
 *     `db:clearAll` parity test in `ipc-handlers-db.test.ts`);
 *   - an `information_schema` sweep on a real migrated PGlite requires every
 *     existing table to be registered cleared or excluded-with-reason
 *     (`reset-table-coverage.integration.test.ts`).
 *
 * What none of those can see is the union DECLARATIONS themselves regressing:
 * someone re-inlining a hand-enumerated literal union (recreating the drift
 * channel this guard was born for) or widening a helper parameter to `string`
 * (destroying the closed-union guarantee outright). This guard now pins
 * exactly that — the declarations must stay derived from the registry.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const DESKTOP_SOURCE = path.join(repoRoot, 'apps/desktop/src/ipc-domains/db-reset-relation.ts');
const RENDERER_SOURCE = path.join(repoRoot, 'packages/db/src/pglite-direct-transport.ts');
const REGISTRY_SOURCE = path.join(repoRoot, 'packages/db/src/reset-table-registry.ts');

function readSource(sourcePath) {
  return readFileSync(sourcePath, 'utf8');
}

function readDeclaration(sourcePath, typeName) {
  const declaration = readSource(sourcePath).match(new RegExp(`type ${typeName} =([^;]+);`, 'u'));
  assert.ok(
    declaration,
    `Could not find "type ${typeName} = …;" in ${path.relative(repoRoot, sourcePath)}. ` +
      'If the union moved or was renamed, teach this guard the new shape rather than deleting it.'
  );
  return declaration[1].replaceAll(/\s+/gu, ' ').trim();
}

test('the renderer union is the registry union, not a hand-enumerated list', () => {
  assert.equal(
    readDeclaration(RENDERER_SOURCE, 'ClearableRelation'),
    'FactoryResetOnlyTable | ResetTable',
    'ClearableRelation must stay derived from the reset-table registry (BST-992). ' +
      'Re-inlining a literal union recreates the two-drifting-lists failure class ' +
      'this guard exists for — add tables to the REGISTRY instead.'
  );
});

test('the desktop union is the registry union minus the two bare-DELETE tables', () => {
  assert.equal(
    readDeclaration(DESKTOP_SOURCE, 'OptionalRelationTable'),
    'Exclude<ResetTable, BareDeletedTable>',
    'OptionalRelationTable must stay derived from the reset-table registry (BST-992). ' +
      'file_chunks/file_records are the only legitimate exclusions: desktop counts and ' +
      'bare-DELETEs them (never probed, never legitimately absent). Any other divergence ' +
      'belongs in the registry, not here.'
  );
  // `Exclude` fails open (a renamed registry member silently stops being
  // excluded), so the excluded names must flow through the constrained
  // `RegisteredBareDeleted<T extends ResetTable>` alias, which turns that
  // silent widening into a compile error (review #2155).
  assert.equal(
    readDeclaration(DESKTOP_SOURCE, 'BareDeletedTable'),
    "RegisteredBareDeleted<'file_chunks' | 'file_records'>",
    'BareDeletedTable must keep naming its two literals through RegisteredBareDeleted so ' +
      'a registry rename is a type error, not a silently widened probe union.'
  );
});

test('both sides import ResetTable from the registry', () => {
  assert.match(
    readSource(RENDERER_SOURCE),
    /import type \{ FactoryResetOnlyTable, ResetTable \} from '\.\/reset-table-registry\.js'/u,
    'pglite-direct-transport.ts must import ResetTable from ./reset-table-registry.js ' +
      '(relative — a package must never import its own barrel).'
  );
  assert.match(
    readSource(DESKTOP_SOURCE),
    /import type \{ ResetTable \} from '@brainstrike\/db'/u,
    "db-reset-relation.ts must type-import ResetTable (via '@brainstrike/db')."
  );
});

test('the probe helpers still take the closed union, never string', () => {
  // The whole point of the closed union: with to_regclass a stale name is a
  // permanent silent skip, so a `string` parameter would let any caller
  // reintroduce that hazard invisibly.
  assert.match(
    readSource(RENDERER_SOURCE),
    /table: ClearableRelation/u,
    'clearRelationIfPresent must keep its ClearableRelation parameter.'
  );
  assert.match(
    readSource(DESKTOP_SOURCE),
    /tableName: OptionalRelationTable/u,
    'clearOptionalRelation must keep its OptionalRelationTable parameter.'
  );
});

test('the registry still assembles Mastra values inside functions only', () => {
  const registry = readSource(REGISTRY_SOURCE);
  // Belt-and-suspenders next to verify-mastra-schema-init-order.mjs: the
  // registry is the one module whose whole job is naming these constants, so
  // pin that its runtime arrays come from function bodies (chunk-init safe),
  // not module-scope consts.
  assert.match(registry, /export function getMastraResetTables\(\)/u);
  assert.match(registry, /export function getResetTables\(\)/u);
});
