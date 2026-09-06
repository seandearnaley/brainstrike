import assert from 'node:assert/strict';
import { test } from 'node:test';

const { collectCompiledFunctions, diffInventories, inventorySource, BACKENDS } = await import(
  '../react-compiler-inventory.mjs'
);

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
  const baseline = {
    backend: 'babel',
    functions: [
      { file: 'a.tsx', name: 'Kept', status: 'compiled' },
      { file: 'a.tsx', name: 'Lost', status: 'compiled' },
      { file: 'a.tsx', name: 'StillBailed', reason: 'Todo: ??=', status: 'bailed' },
    ],
  };
  const candidate = {
    backend: 'oxc',
    functions: [
      { file: 'a.tsx', name: 'Kept', status: 'compiled' },
      { file: 'a.tsx', name: 'Gained', status: 'compiled' },
    ],
  };

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
