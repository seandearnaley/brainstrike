import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  assertInventoryComplete,
  buildInventory,
  collectCompiledFunctions,
  diffInventories,
  inventorySource,
  isMatchable,
  BACKENDS,
  INVENTORY_FORMAT,
} = await import('../react-compiler-inventory.mjs');

/** A minimal well-formed inventory: the diff refuses anything it cannot read. */
function inventory(backend, functions) {
  return { backend, failures: [], functions, inventoryFormat: INVENTORY_FORMAT };
}

const COMPILED_OUTPUT = `
import { c as _c } from "react/compiler-runtime";
export function Widget(t0) {
  const $ = _c(8);
  return $[0];
}
export const Panel = t0 => {
  const $ = _c(3);
  return $[0];
};
export function plainHelper(a) {
  return a + 1;
}
`;

test('collectCompiledFunctions reports every function holding a compiler cache slot', () => {
  const compiled = collectCompiledFunctions(COMPILED_OUTPUT);
  assert.deepEqual(
    compiled.map((entry) => [entry.name, entry.memoSlots]),
    [
      ['Widget', 8],
      ['Panel', 3],
    ]
  );
});

test('collectCompiledFunctions keys off the compiler-runtime binding, not the `_c` spelling', () => {
  // Same shape, but `_c` is a local helper rather than the compiler runtime cache.
  const decoy = `
    const _c = (n) => new Array(n);
    export function Widget() {
      const $ = _c(8);
      return $[0];
    }
  `;
  assert.deepEqual(collectCompiledFunctions(decoy), []);
});

test('collectCompiledFunctions follows a renamed compiler-runtime binding', () => {
  const renamed = `
    import { c as _c2 } from "react/compiler-runtime";
    export function Widget() {
      const $ = _c2(4);
      return $[0];
    }
  `;
  assert.deepEqual(
    collectCompiledFunctions(renamed).map((entry) => [entry.name, entry.memoSlots]),
    [['Widget', 4]]
  );
});

test('diffInventories names regressions and wins in both directions', () => {
  const baseline = inventory('babel', [
    { file: 'a.tsx', matchable: true, name: 'Kept', status: 'compiled' },
    { file: 'a.tsx', matchable: true, name: 'Lost', status: 'compiled' },
    {
      file: 'a.tsx',
      matchable: true,
      name: 'StillBailed',
      reason: 'Todo: ??=',
      status: 'bailed',
    },
  ]);
  const candidate = inventory('oxc', [
    { file: 'a.tsx', matchable: true, name: 'Kept', status: 'compiled' },
    { file: 'a.tsx', matchable: true, name: 'Gained', status: 'compiled' },
  ]);

  const diff = diffInventories(baseline, candidate);

  assert.deepEqual(
    diff.regressions.map((entry) => entry.key),
    ['a.tsx::Lost']
  );
  assert.deepEqual(
    diff.wins.map((entry) => entry.key),
    ['a.tsx::Gained']
  );
  assert.equal(diff.unchanged, 1);
  // The candidate backend may not be able to explain bailouts, but a function the baseline
  // saw fail and the candidate did not compile is still not memoized — name it.
  assert.deepEqual(
    diff.stillBailed.map((entry) => entry.key),
    ['a.tsx::StillBailed']
  );
});

test('an unknown backend throws instead of silently picking one', () => {
  assert.throws(
    () => inventorySource({ backend: 'swc', filename: 'a.tsx', source: 'export const A = 1;' }),
    /Unknown React Compiler backend "swc"/u
  );
  assert.deepEqual(BACKENDS, ['babel', 'oxc']);
});

test('buildInventory rejects an unknown backend BEFORE it scans a single file', () => {
  // The per-file try/catch used to funnel this throw into `failures`, so a typo'd --backend
  // produced one identical failure per source file, wrote the JSON, and exited 0.
  assert.throws(
    () =>
      buildInventory({ backend: 'swc', repoRoot: '/react-compiler-inventory-no-such-repo-root' }),
    /Unknown React Compiler backend "swc"/u
  );
});

test('an inventory with analysis failures is refused, not reported as an absence', () => {
  assert.throws(
    () =>
      assertInventoryComplete({
        failures: [{ file: 'a.tsx', message: 'Unexpected token' }],
        summary: { bailed: 0, compiled: 0 },
      }),
    /1 file\(s\) failed to analyse/u
  );
  assert.equal(
    assertInventoryComplete({ failures: [], summary: { bailed: 0, compiled: 0 } }),
    undefined
  );
});

const METHOD_OUTPUT = `
import { c as _c } from "react/compiler-runtime";
export const handlers = {
  Row(t0) {
    const $ = _c(2);
    return $[0];
  },
};
export class Panel {
  Body(t0) {
    const $ = _c(3);
    return $[0];
  }
}
`;

test('collectCompiledFunctions names object and class methods from their own key', () => {
  // `ObjectMethod`/`ClassMethod` ARE the function node, so the parent walk starts at
  // `ObjectExpression`/`ClassBody` and never sees the key. They used to land in the
  // anonymous bucket, which the diff cannot match across backends.
  assert.deepEqual(
    collectCompiledFunctions(METHOD_OUTPUT).map((entry) => entry.name),
    ['Row', 'Body']
  );
});

const ANONYMOUS_OUTPUT = `
import { c as _c } from "react/compiler-runtime";
export default function (t0) {
  const $ = _c(2);
  return $[0];
}
`;

test('collectCompiledFunctions reports an unnameable function as null, never as a line number', () => {
  // This runs over COMPILED OUTPUT: an output line number is not an identity. Babel and oxc
  // emit different layouts, so naming by line makes an identical pair of inventories report
  // the same function as both a regression and a win.
  assert.deepEqual(
    collectCompiledFunctions(ANONYMOUS_OUTPUT).map((entry) => entry.name),
    [null]
  );
});

test('diffInventories drops records it cannot identify instead of inventing a key', () => {
  const baseline = inventory('babel', [
    { file: 'a.tsx', line: 12, matchable: false, name: '(anonymous)', status: 'compiled' },
    { file: 'a.tsx', line: 1, matchable: true, name: 'Kept', status: 'compiled' },
    { file: 'a.tsx', line: 20, matchable: false, name: 'Twin', status: 'compiled' },
    { file: 'a.tsx', line: 40, matchable: false, name: 'Twin', status: 'compiled' },
  ]);
  const candidate = inventory('oxc', [
    { file: 'a.tsx', line: 31, matchable: false, name: '(anonymous)', status: 'compiled' },
    { file: 'a.tsx', line: 1, matchable: true, name: 'Kept', status: 'compiled' },
    { file: 'a.tsx', line: 20, matchable: false, name: 'Twin', status: 'compiled' },
    { file: 'a.tsx', line: 40, matchable: false, name: 'Twin', status: 'compiled' },
  ]);

  const diff = diffInventories(baseline, candidate);

  assert.deepEqual(diff.regressions, []);
  assert.deepEqual(diff.wins, []);
  assert.equal(diff.unchanged, 1);
  assert.deepEqual(diff.unmatchable, { baseline: 3, candidate: 3 });
});

const DUPLICATE_NAME_FIXTURE = `
import { useState } from 'react';

export function makeFirst() {
  function Row({ items }) {
    const [n] = useState(0);
    return <li>{items.join(',')}{n}</li>;
  }
  return Row;
}

export function makeSecond() {
  function Row({ items }) {
    const [n] = useState(0);
    return <li>{items.join('-')}{n}</li>;
  }
  return Row;
}
`;

test('two functions sharing a name in one file are marked unmatchable at the source', () => {
  // Repeated local names (`Row`, `run`, `onDrop`) are ordinary. Both compile, both key to
  // `file::Row`, and one silently shadows the other unless the producer says so.
  for (const backend of BACKENDS) {
    const report = inventorySource({
      backend,
      filename: '/repo/dup.jsx',
      source: DUPLICATE_NAME_FIXTURE,
    });
    const rows = report.functions.filter((entry) => entry.name === 'Row');

    assert.equal(rows.length, 2, `${backend} must record both same-named functions`);
    for (const row of rows) {
      assert.equal(row.status, 'compiled');
      assert.equal(row.ambiguousName, true, `${backend} must flag the shared name`);
      assert.equal(row.matchable, false, `${backend} must not offer a shared name as a key`);
    }
  }
});

test('a duplicated key is dropped even when the record claims to be matchable', () => {
  // The diff does not trust the producer's flag alone for COMPILED records: it recounts
  // compiled occurrences per key, so an older or buggy producer cannot fold two compiled
  // functions onto one key. (A compiled/bailed name collision is not recounted — the
  // producer's source-side duplicate detection already covers both statuses.) Baseline
  // compiles `Twin` twice and the candidate once: folding them reports "unchanged".
  const baseline = inventory('babel', [
    { file: 'a.tsx', line: 20, matchable: true, name: 'Twin', status: 'compiled' },
    { file: 'a.tsx', line: 40, matchable: true, name: 'Twin', status: 'compiled' },
  ]);
  const candidate = inventory('oxc', [
    { file: 'a.tsx', line: 20, matchable: true, name: 'Twin', status: 'compiled' },
  ]);

  const diff = diffInventories(baseline, candidate);

  assert.equal(diff.unchanged, 0, 'a shared key must never be reported as an unchanged pair');
  assert.deepEqual(diff.regressions, []);
  assert.deepEqual(diff.wins, []);
  assert.deepEqual(diff.unmatchable, { baseline: 2, candidate: 1 });
});

test('a name is matchable only when it is real, unique, and present in the source', () => {
  const noDuplicates = new Set();

  assert.equal(isMatchable('Row', noDuplicates, true), true);
  assert.equal(isMatchable(null, noDuplicates, true), false, 'an unnameable function has no key');
  assert.equal(
    isMatchable('Row', new Set(['Row']), true),
    false,
    'a name shared inside one file cannot identify one of them'
  );
  // Names come from the COMPILED output. One a backend synthesized (an outlined helper, a
  // hoisted temp) has no source function behind it, and two backends need not spell it the
  // same way — keying it reports one function as a regression AND a win.
  assert.equal(
    isMatchable('_temp$1', noDuplicates, false),
    false,
    'a name absent from the source is not an identity'
  );
});

test('a loss on a name too ambiguous to attribute is reported, not silently dropped', () => {
  // Baseline compiles `Twin` twice, candidate compiles it zero times. Both keys are
  // dropped as ambiguous, so `regressions` is empty — and without this bucket the diff
  // prints "0 regressed" and exits 0 while two functions lost memoization.
  const baseline = inventory('babel', [
    { file: 'a.tsx', line: 20, matchable: true, name: 'Twin', status: 'compiled' },
    { file: 'a.tsx', line: 40, matchable: true, name: 'Twin', status: 'compiled' },
  ]);
  const candidate = inventory('oxc', []);

  const diff = diffInventories(baseline, candidate);

  assert.deepEqual(diff.regressions, []);
  assert.deepEqual(diff.ambiguousLosses, [{ baseline: 2, candidate: 0, key: 'a.tsx::Twin' }]);
});

test('gaining coverage on an ambiguous name is not reported as a loss', () => {
  // The mirror of the cross-side drop: ambiguous in the CANDIDATE, unique in the baseline.
  // The key must leave both sides — keeping the baseline's would manufacture a regression.
  const baseline = inventory('babel', [
    { file: 'a.tsx', line: 20, matchable: true, name: 'Twin', status: 'compiled' },
  ]);
  const candidate = inventory('oxc', [
    { file: 'a.tsx', line: 20, matchable: true, name: 'Twin', status: 'compiled' },
    { file: 'a.tsx', line: 40, matchable: true, name: 'Twin', status: 'compiled' },
  ]);

  const diff = diffInventories(baseline, candidate);

  assert.deepEqual(diff.regressions, []);
  assert.deepEqual(diff.wins, []);
  assert.deepEqual(diff.ambiguousLosses, []);
  assert.equal(diff.unchanged, 0);
  assert.deepEqual(diff.unmatchable, { baseline: 1, candidate: 2 });
});

test('a bailout is not called "still not memoized" when the candidate compiled that name', () => {
  // `stillBailed` asks a question about the CANDIDATE, so it must not be answered from a
  // key map that ambiguity emptied two statements earlier.
  const baseline = inventory('babel', [
    { file: 'a.tsx', line: 5, matchable: true, name: 'Foo', reasons: [], status: 'bailed' },
  ]);
  const candidate = inventory('oxc', [
    { file: 'a.tsx', line: 5, matchable: true, name: 'Foo', status: 'compiled' },
    { file: 'a.tsx', line: 9, matchable: true, name: 'Foo', status: 'compiled' },
  ]);

  const diff = diffInventories(baseline, candidate);

  assert.deepEqual(diff.stillBailed, []);
});

test('diffInventories refuses an inventory written by an older script', () => {
  const stale = { backend: 'babel', failures: [], functions: [] };
  assert.throws(
    () => diffInventories(stale, inventory('oxc', [])),
    /baseline inventory is format unversioned/u
  );
  assert.throws(
    () => diffInventories(inventory('babel', []), stale),
    /candidate inventory is format unversioned/u
  );
});

test('diffInventories refuses an inventory that failed to analyse part of the tree', () => {
  const broken = {
    backend: 'oxc',
    failures: [{ file: 'a.tsx', message: 'Unexpected token' }],
    functions: [],
    inventoryFormat: INVENTORY_FORMAT,
  };
  assert.throws(
    () => diffInventories(inventory('babel', []), broken),
    /1 file\(s\) failed to analyse/u
  );
});

const MIXED_FIXTURE = `
import { useState } from 'react';

export function GoodComponent({ items }) {
  const [n, setN] = useState(0);
  const joined = items.join(',');
  return <div onClick={() => setN(n + 1)}>{joined}{n}</div>;
}

export function LogicalAssignComponent({ items }) {
  const [n] = useState(0);
  let acc;
  acc ??= items.join('-');
  return <div>{acc}{n}</div>;
}
`;

test('the babel backend reports compiled functions and bailouts with a reason', () => {
  const report = inventorySource({
    backend: 'babel',
    filename: '/repo/fixture.jsx',
    source: MIXED_FIXTURE,
  });

  assert.equal(report.bailoutReasonsSupported, true);

  const good = report.functions.find((entry) => entry.name === 'GoodComponent');
  assert.equal(good?.status, 'compiled');
  assert.ok(good.memoSlots > 0, 'a compiled component must own at least one memo slot');

  const bailed = report.functions.find((entry) => entry.name === 'LogicalAssignComponent');
  assert.equal(bailed?.status, 'bailed');
  assert.match(bailed.reasons[0].reason, /\?\?= operators/u);
});

const MULTI_ERROR_FIXTURE = `
import { useState } from 'react';

export function DefaultsComponent({ first = 'a', second = 'b', third = 'c' }) {
  const [n] = useState(0);
  return <div>{first}{second}{third}{n}</div>;
}
`;

test('a function that fails several times is ONE bailout, not one per error site', () => {
  // The compiler logs a CompileError per failing site. Counting events instead of functions
  // inflates the bailout total (466 events over 258 functions on this repo at BST-1659).
  const report = inventorySource({
    backend: 'babel',
    filename: '/repo/defaults.jsx',
    source: MULTI_ERROR_FIXTURE,
  });

  const bailed = report.functions.filter((entry) => entry.status === 'bailed');
  assert.equal(bailed.length, 1, 'one failing function must produce exactly one record');
  assert.equal(bailed[0].name, 'DefaultsComponent');
  assert.ok(
    bailed[0].reasons.length > 1,
    'every distinct failure site must still be retained on that single record'
  );
});

test('a .ts module may use generic arrow functions, which JSX parsing would reject', () => {
  // `<T>(…) => …` is a type-parameter list in .ts and an unterminated JSX tag in .tsx.
  // Enabling the JSX parser plugin for every file drops these modules from the inventory.
  const genericArrow = `
    export const pick = <T>(items: readonly T[]): T => {
      if (items.length === 0) {
        throw new Error('empty');
      }
      return items[0];
    };
  `;
  for (const backend of BACKENDS) {
    const report = inventorySource({
      backend,
      filename: '/repo/utils.ts',
      source: genericArrow,
    });
    assert.deepEqual(report.functions, [], `${backend} must analyse .ts generics without throwing`);
  }
});

test('the oxc backend reports compiled functions and declares that it cannot explain bailouts', () => {
  const report = inventorySource({
    backend: 'oxc',
    filename: '/repo/fixture.jsx',
    source: MIXED_FIXTURE,
  });

  assert.equal(report.bailoutReasonsSupported, false);

  const compiledNames = report.functions
    .filter((entry) => entry.status === 'compiled')
    .map((entry) => entry.name);
  assert.deepEqual(compiledNames, ['GoodComponent']);
  assert.equal(
    report.functions.some((entry) => entry.name === 'LogicalAssignComponent'),
    false,
    'oxc exposes no per-function diagnostics, so it must not invent bailout records'
  );
});

test('both backends agree on which functions the compiler memoizes', () => {
  const babel = inventorySource({
    backend: 'babel',
    filename: '/repo/fixture.jsx',
    source: MIXED_FIXTURE,
  });
  const oxc = inventorySource({
    backend: 'oxc',
    filename: '/repo/fixture.jsx',
    source: MIXED_FIXTURE,
  });

  const compiled = (report) =>
    report.functions
      .filter((entry) => entry.status === 'compiled')
      .map((entry) => entry.name)
      .sort();

  assert.deepEqual(compiled(oxc), compiled(babel));
});
