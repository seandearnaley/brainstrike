import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// BST-1335: `RuntimeWorkspaceIndexStatusState` in @brainstrike/assistant-contract
// hand-mirrors `WorkspaceCollectionSyncState` in @brainstrike/app-state. The
// duplication is deliberate — assistant-contract is the dependency-light wire
// contract and must not import app-state — but "keep in sync by hand" is not a
// mechanism, it is a hope.
//
// This repo has already paid for that hope once: BST-1310 records three
// packages hand-mirroring an @ai-sdk/anthropic union whose doc comments still
// named version 4.0.8 after the provider moved to 4.0.39
// (scripts/__tests__/ai-sdk-anthropic-mirror-contract.test.mjs is the guard
// that came out of it). This file is the same guard for the same class of
// defect, added with the mirror rather than after it drifts.
//
// The failure modes are asymmetric and both reach runtime against a green
// type-check: a wire union NARROWER than the store's drops a state the app can
// actually enter (it arrives as an unmodelled string at the boundary), and one
// WIDER advertises a state nothing ever produces. Membership equality is the
// only honest contract.
const STORE_UNION = {
  file: 'packages/app-state/src/stores/workspace-collection-sync-status-store.ts',
  typeName: 'WorkspaceCollectionSyncState',
};
const WIRE_UNION = {
  file: 'packages/assistant-contract/src/runtime-data.ts',
  typeName: 'RuntimeWorkspaceIndexStatusState',
};

/**
 * Anti-vacuous floor: both unions are well over this today. A parser that
 * silently matched nothing would otherwise "prove" two empty sets equal.
 */
const MIN_UNION_MEMBERS = 8;

/**
 * Reads `export type <typeName> = 'a' | 'b' | …;` and returns its string
 * literal members. Throws rather than returning empty when the declaration
 * cannot be found — a guard that cannot locate its subject must fail loudly,
 * not pass (BST-836).
 */
function readUnionMembers({ file, typeName }) {
  const source = readFileSync(path.join(repoRoot, file), 'utf8');
  const declarationIndex = source.indexOf(`export type ${typeName} =`);
  assert.ok(
    declarationIndex !== -1,
    `${file} no longer declares \`export type ${typeName} =\`. If it was renamed or moved, ` +
      'update this contract — do not delete it.'
  );
  const terminatorIndex = source.indexOf(';', declarationIndex);
  assert.ok(terminatorIndex !== -1, `${typeName} in ${file} has no terminating semicolon.`);
  const body = source.slice(declarationIndex, terminatorIndex);
  const members = [...body.matchAll(/'([a-z-]+)'/gu)].map((match) => match[1]);
  assert.ok(
    members.length >= MIN_UNION_MEMBERS,
    `Parsed only ${members.length} member(s) from ${typeName} in ${file} (floor: ` +
      `${MIN_UNION_MEMBERS}). The declaration shape probably changed and this contract is ` +
      'no longer reading it — fix the parser rather than lowering the floor.'
  );
  return members.sort();
}

test('the workspace sync wire union mirrors the store union exactly', () => {
  const storeMembers = readUnionMembers(STORE_UNION);
  const wireMembers = readUnionMembers(WIRE_UNION);

  assert.deepEqual(
    wireMembers,
    storeMembers,
    `${WIRE_UNION.typeName} (${WIRE_UNION.file}) has drifted from ${STORE_UNION.typeName} ` +
      `(${STORE_UNION.file}).\n` +
      `  only in the store: ${storeMembers.filter((m) => !wireMembers.includes(m)).join(', ') || '—'}\n` +
      `  only on the wire:  ${wireMembers.filter((m) => !storeMembers.includes(m)).join(', ') || '—'}\n` +
      'Add the state to BOTH unions. assistant-contract cannot import app-state, so the ' +
      'duplication is intentional and this contract is what keeps it honest.'
  );
});

test('CONTROL: a drifted mirror is detected', () => {
  // Proves the comparison can fail: a guard never observed failing is not
  // evidence (BST-836).
  const storeMembers = ['error', 'idle', 'unconfigured'];
  const driftedWireMembers = ['error', 'idle'];
  assert.throws(() => {
    assert.deepEqual(driftedWireMembers, storeMembers);
  });
});
