import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyCommand, extractProject, flattenScript } from '../ts7-parity-check.mjs';

// The parity guard's whole value is surviving a future repo restructuring
// without silently mis-parsing. These tests pin the two parsing behaviours that
// a restructuring is most likely to hit, and that a reader is most likely to
// "simplify" wrongly.

const manifest = (scripts) => ({
  dir: '/repo/packages/thing',
  name: '@brainstrike/thing',
  scripts,
});

describe('flattenScript — path-scoped cycle detection', () => {
  it('follows pnpm script chains and inlines them in order', () => {
    const m = manifest({
      'type-check': 'pnpm type-check:main && pnpm type-check:e2e',
      'type-check:e2e': 'tsc --noEmit --project tsconfig.e2e.json',
      'type-check:main': 'tsc --noEmit && tsc --noEmit --project tsconfig.main.json',
    });
    assert.deepEqual(flattenScript(m, 'type-check'), [
      'tsc --noEmit',
      'tsc --noEmit --project tsconfig.main.json',
      'tsc --noEmit --project tsconfig.e2e.json',
    ]);
  });

  it('DIAMOND: a script reached twice via sibling branches is NOT a cycle', () => {
    // Visited-semantics (add-and-never-remove) would wrongly throw here: tc:shared
    // is reached via tc:a, then again via tc:b. Neither is an ancestor of the
    // other, so this is a legitimate diamond and must flatten to both visits.
    const m = manifest({
      'tc:a': 'pnpm tc:shared',
      'tc:b': 'pnpm tc:shared',
      'tc:shared': 'tsc --noEmit',
      'type-check': 'pnpm tc:a && pnpm tc:b',
    });
    assert.deepEqual(flattenScript(m, 'type-check'), ['tsc --noEmit', 'tsc --noEmit']);
  });

  it('CYCLE: a script that is its own ancestor still throws', () => {
    // The `finally` delete must not defang real cycle detection: `a` is still on
    // the active path when re-entered, so this must throw rather than recurse
    // until the stack overflows.
    const m = manifest({
      'tc:a': 'pnpm tc:b',
      'tc:b': 'pnpm tc:a',
      'type-check': 'pnpm tc:a',
    });
    assert.throws(() => flattenScript(m, 'type-check'), /Cycle detected/);
  });

  it('CYCLE: a self-referential script throws', () => {
    const m = manifest({ 'type-check': 'pnpm type-check' });
    assert.throws(() => flattenScript(m, 'type-check'), /Cycle detected/);
  });

  it('a missing script reference throws rather than being skipped', () => {
    const m = manifest({ 'type-check': 'pnpm tc:nope' });
    assert.throws(() => flattenScript(m, 'type-check'), /no script named "tc:nope"/);
  });
});

describe('extractProject — every tsc project-flag spelling', () => {
  it('extracts all four accepted forms', () => {
    assert.equal(extractProject('tsc --noEmit --project tsconfig.foo.json'), 'tsconfig.foo.json');
    assert.equal(extractProject('tsc --noEmit --project=tsconfig.foo.json'), 'tsconfig.foo.json');
    assert.equal(extractProject('tsc -p tsconfig.foo.json --noEmit'), 'tsconfig.foo.json');
    assert.equal(extractProject('tsc -p=tsconfig.foo.json --noEmit'), 'tsconfig.foo.json');
  });

  it('returns null when no project flag is present', () => {
    assert.equal(extractProject('tsc --noEmit'), null);
    assert.equal(extractProject('tsc --noEmit --pretty false'), null);
  });

  it('does not mistake --pretty for -p', () => {
    // `-p` inside `--pretty` is preceded by `-`, not whitespace, so it must not
    // match. If it did, `false` would be silently used as the project path.
    assert.equal(extractProject('tsc --noEmit --pretty false'), null);
    assert.equal(
      extractProject('tsc --pretty false --project tsconfig.test.json'),
      'tsconfig.test.json'
    );
  });

  it('THROWS on a project flag whose value cannot be parsed (no silent default)', () => {
    // The dangerous case: silently returning null here would make runTsc check
    // the package's default tsconfig.json under BOTH compilers, reporting parity
    // for a project CI never runs.
    assert.throws(() => extractProject('tsc --noEmit --project'), /Could not parse a project path/);
    assert.throws(() => extractProject('tsc --noEmit -p'), /Could not parse a project path/);
  });
});

describe('classifyCommand', () => {
  it('classifies --noEmit runs and carries the resolved project', () => {
    assert.deepEqual(classifyCommand('tsc --noEmit'), {
      command: 'tsc --noEmit',
      kind: 'noEmit',
      project: null,
    });
    assert.deepEqual(classifyCommand('tsc -p tsconfig.foo.json --noEmit'), {
      command: 'tsc -p tsconfig.foo.json --noEmit',
      kind: 'noEmit',
      project: 'tsconfig.foo.json',
    });
  });

  it('tags build and non-tsc commands instead of comparing them', () => {
    assert.equal(classifyCommand('tsc --build --force').kind, 'build');
    assert.equal(classifyCommand('tsc -b').kind, 'build');
    assert.equal(classifyCommand('node --check index.cjs').kind, 'non-tsc');
  });

  it('tags a tsc command with no --noEmit as unrecognized rather than running it', () => {
    assert.equal(classifyCommand('tsc --emitDeclarationOnly').kind, 'unrecognized');
  });
});
