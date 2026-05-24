import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  AFFECTED_WORKSPACES_MODE,
  CHANGED_UNIT_TEST_MODE,
  detectUnitProofMode,
  parseUnitProofModeArgs,
  runCli,
} from '../ci-unit-proof-mode.mjs';

function manifest(commands) {
  return {
    selection: {
      commands: commands.map((name) => ({ name })),
    },
  };
}

test('detectUnitProofMode selects changed unit test mode from proof commands', () => {
  assert.equal(
    detectUnitProofMode(manifest(['diff-check', 'changed-unit-tests'])),
    CHANGED_UNIT_TEST_MODE
  );
});

test('detectUnitProofMode selects affected workspace mode for ordinary unit proof', () => {
  assert.equal(
    detectUnitProofMode(manifest(['diff-check', 'ci-script-tests', 'workflow-contracts'])),
    AFFECTED_WORKSPACES_MODE
  );
});

test('detectUnitProofMode fails closed when proof commands are missing', () => {
  assert.throws(() => detectUnitProofMode({ selection: {} }), /selection\.commands/);
});

test('parseUnitProofModeArgs accepts explicit proof and github output paths', () => {
  assert.deepEqual(
    parseUnitProofModeArgs(['--proof', 'proof.json', '--github-output', 'output.txt']),
    {
      githubOutput: 'output.txt',
      proof: 'proof.json',
    }
  );
});

test('runCli writes mode to GitHub output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brainstrike-unit-proof-mode-'));
  try {
    const proof = join(dir, 'proof.json');
    const output = join(dir, 'github-output.txt');
    await writeFile(proof, JSON.stringify(manifest(['changed-unit-tests'])));

    assert.equal(await runCli(['--proof', proof, '--github-output', output]), 0);
    assert.equal(await readFile(output, 'utf8'), 'mode=changed-unit-tests\n');
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('runCli returns non-zero for malformed proof manifests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brainstrike-unit-proof-mode-'));
  try {
    const proof = join(dir, 'proof.json');
    await writeFile(proof, JSON.stringify({ selection: {} }));

    assert.equal(await runCli(['--proof', proof]), 1);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
