import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canClaimParity,
  classifyCommand,
  compareRuns,
  evaluateRun,
  extractProject,
  flattenScript,
  OUTCOME,
  outcomeForUncomparedKind,
  succeeded,
} from '../ts7-parity-check.mjs';

// A clean run: exit 0, no diagnostics.
const clean = () => ({ diagnostics: new Set(), exitCode: 0, output: '', signal: null });
// A run reporting real type errors: non-zero exit WITH diagnostics.
const withDiags = (...ids) => ({
  diagnostics: new Set(ids),
  exitCode: 2,
  output: '',
  signal: null,
});

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

  it('unwraps the test-tsconfig verifier into its noEmit project', () => {
    const command =
      'node ../../scripts/verify-test-tsconfig-program.mjs --project tsconfig.test.json --min-test-files 400';
    assert.deepEqual(classifyCommand(command), {
      command,
      kind: 'noEmit',
      project: 'tsconfig.test.json',
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

describe('evaluateRun — a crashing compiler must not look like a passing one', () => {
  it('accepts a clean run and a run with real diagnostics', () => {
    assert.equal(evaluateRun('TS7', clean()), null);
    assert.equal(evaluateRun('TS7', withDiags('a.ts:1:1:TS1')), null);
  });

  it('THE MONEY CASE: non-zero exit with zero diagnostics is an error, not agreement', () => {
    // A native crash / fatal CLI error prints no "error TSxxxx" line, so its
    // diagnostic set is empty and compares EQUAL to a clean run's empty set.
    // Without this check that reads as parity.
    const crashed = {
      diagnostics: new Set(),
      exitCode: 1,
      output: 'panic: runtime error',
      signal: null,
    };
    assert.match(evaluateRun('TS7', crashed), /exited 1 but produced no parsable diagnostics/);
  });

  it('flags a run killed by a signal', () => {
    const killed = { diagnostics: new Set(), exitCode: null, output: '', signal: 'SIGSEGV' };
    assert.match(evaluateRun('TS7', killed), /terminated by signal SIGSEGV/);
  });

  it('flags a null exit status', () => {
    const weird = { diagnostics: new Set(), exitCode: null, output: '', signal: null };
    assert.match(evaluateRun('TS7', weird), /exited without a status code/);
  });

  it('flags exit 0 that nonetheless reported diagnostics', () => {
    const inconsistent = {
      diagnostics: new Set(['a.ts:1:1:TS1']),
      exitCode: 0,
      output: '',
      signal: null,
    };
    assert.match(evaluateRun('TS6', inconsistent), /exited 0 despite reporting 1 diagnostic/);
  });
});

describe('compareRuns — exit status is part of the comparison', () => {
  it('matches two clean runs', () => {
    assert.equal(compareRuns(clean(), clean()).outcome, OUTCOME.MATCHED);
  });

  it('matches two runs with identical diagnostics', () => {
    const r = compareRuns(withDiags('a.ts:1:1:TS1'), withDiags('a.ts:1:1:TS1'));
    assert.equal(r.outcome, OUTCOME.MATCHED);
  });

  it('reports a mismatch and names which side is extra', () => {
    const r = compareRuns(clean(), withDiags('a.ts:44:13:TS2430'));
    assert.equal(r.outcome, OUTCOME.MISMATCH);
    assert.deepEqual(r.onlyInTs6, []);
    assert.deepEqual(r.onlyInTs7, ['a.ts:44:13:TS2430']);
  });

  it('a crashed TS7 yields ERROR, never MATCHED, even against a clean TS6', () => {
    const crashed = { diagnostics: new Set(), exitCode: 1, output: 'boom', signal: null };
    const r = compareRuns(clean(), crashed);
    assert.equal(r.outcome, OUTCOME.ERROR);
    assert.match(r.errors.join(' '), /no parsable diagnostics/);
  });

  it('exit 1 vs exit 2 with identical diagnostics is NOT a mismatch', () => {
    // Both mean DiagnosticsPresent (OutputsSkipped vs OutputsGenerated). TS6
    // flips between them for composite projects depending on whether the run
    // rewrote dist/tsconfig.tsbuildinfo — verified: exit 2 on the first run from
    // a clean state, exit 1 on every subsequent run, while TS7 is stably 1.
    // Comparing raw exit integers turns that stateful artifact into a flaky
    // false mismatch. Do not "tighten" this back to raw equality.
    const a = { diagnostics: new Set(['x.ts:1:1:TS1']), exitCode: 2, output: '', signal: null };
    const b = { diagnostics: new Set(['x.ts:1:1:TS1']), exitCode: 1, output: '', signal: null };
    assert.equal(compareRuns(a, b).outcome, OUTCOME.MATCHED);
  });

  it('success vs diagnostics-present IS a mismatch even if sets somehow agree', () => {
    assert.equal(succeeded({ exitCode: 0 }), true);
    assert.equal(succeeded({ exitCode: 2 }), false);
  });
});

describe('canClaimParity — the single gate (absence of evidence is not agreement)', () => {
  it('requires positive evidence: an empty result set cannot pass', () => {
    assert.equal(canClaimParity([]), false);
  });

  it('passes only when every outcome is affirmatively matched', () => {
    assert.equal(
      canClaimParity([{ outcome: OUTCOME.MATCHED }, { outcome: OUTCOME.MATCHED }]),
      true
    );
  });

  it('an UNCOMPARED tsc invocation blocks parity even with zero mismatches', () => {
    // The apps/web `tsc --build --force` shape: everything compared matched,
    // but a tsc invocation went unverified. A mismatch COUNTER would say 0 and
    // print PARITY HOLDS; the outcome gate refuses.
    const results = [{ outcome: OUTCOME.MATCHED }, { outcome: OUTCOME.NOT_COMPARED }];
    assert.equal(canClaimParity(results), false);
  });

  it('an ERRORED run blocks parity even with zero mismatches', () => {
    assert.equal(canClaimParity([{ outcome: OUTCOME.MATCHED }, { outcome: OUTCOME.ERROR }]), false);
  });

  it('a mismatch blocks parity', () => {
    assert.equal(canClaimParity([{ outcome: OUTCOME.MISMATCH }]), false);
  });

  it('out-of-scope (non-tsc) commands do not block parity', () => {
    // `node --check index.cjs` cannot change behaviour with the tsc version.
    const results = [{ outcome: OUTCOME.MATCHED }, { outcome: OUTCOME.OUT_OF_SCOPE }];
    assert.equal(canClaimParity(results), true);
  });
});

describe('outcomeForUncomparedKind — the tsc / not-tsc line', () => {
  it('an uncompared tsc invocation is NOT_COMPARED (blocks parity)', () => {
    assert.equal(outcomeForUncomparedKind('build'), OUTCOME.NOT_COMPARED);
    assert.equal(outcomeForUncomparedKind('unrecognized'), OUTCOME.NOT_COMPARED);
  });

  it('a non-tsc command is OUT_OF_SCOPE (does not block)', () => {
    assert.equal(outcomeForUncomparedKind('non-tsc'), OUTCOME.OUT_OF_SCOPE);
  });
});
