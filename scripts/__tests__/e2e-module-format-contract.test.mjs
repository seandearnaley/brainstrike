// Gate for the apps/*/e2e module-format contract (BST-1217).
//
// scripts/e2e-module-format-contract.mjs is a LIBRARY — importing it runs no
// checks. This file is the only thing that turns it into a gate, and it runs in
// `pnpm test:scripts`, which is part of the PR-required Static job rather than
// the nightly desktop-e2e workflow. That placement is the point: the original
// failure was not "the lane broke", it was "the lane broke and nobody found out
// for a week", because desktop-e2e.yml only runs on a schedule.
//
// Every real-tree assertion is paired with a synthetic control that proves the
// same predicate reports a violation when the defect is present. A guard that
// cannot fail is not evidence.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  extractRuntimeStaticSpecifiers,
  findConfigFormatViolations,
  findE2eRoots,
  findEscapingImportViolations,
  findModuleFormatViolations,
  findNearestPackageJson,
  findPlaywrightConfig,
  hasImportMeta,
  hasStarReexport,
  manifestDeclaresEsm,
} from '../e2e-module-format-contract.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Builds a throwaway repo-shaped tree and hands its root to `run`. */
function withFixture(files, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-module-format-'));
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const absolute = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, contents);
    }
    return run(root);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
}

describe('apps/*/e2e module format contract', () => {
  it('discovers every app E2E root that holds specs', () => {
    const roots = findE2eRoots(repoRoot)
      .map((root) => path.relative(repoRoot, root))
      .sort();

    // Both known lanes must be found; a new apps/<x>/e2e is covered automatically.
    assert.deepEqual(roots, ['apps/desktop/e2e', 'apps/web/e2e']);
  });

  it('holds on the real tree: every E2E graph resolves to an ESM manifest', () => {
    assert.deepEqual(findModuleFormatViolations(repoRoot), []);
  });

  it('holds on the real tree: runtime crossings stay CommonJS-safe', () => {
    assert.deepEqual(findEscapingImportViolations(repoRoot), []);
  });

  it('pins the two manifests that carry the contract', () => {
    for (const app of ['desktop', 'web']) {
      const manifest = path.join(repoRoot, 'apps', app, 'e2e', 'package.json');
      assert.ok(fs.existsSync(manifest), `apps/${app}/e2e/package.json must exist`);
      assert.ok(manifestDeclaresEsm(manifest), `apps/${app}/e2e must declare "type": "module"`);

      const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      assert.equal(parsed.private, true, `apps/${app}/e2e manifest must be private`);
      assert.ok(
        typeof parsed['//'] === 'string' && parsed['//'].includes('BST-1217'),
        `apps/${app}/e2e manifest must keep its rationale comment`
      );
    }
  });

  it('holds on the real tree: every Playwright config is ESM alongside its specs', () => {
    assert.deepEqual(findConfigFormatViolations(repoRoot), []);
  });

  it('pins both Playwright configs to .mts', () => {
    for (const app of ['desktop', 'web']) {
      const e2eRoot = path.join(repoRoot, 'apps', app, 'e2e');
      const configPath = findPlaywrightConfig(e2eRoot);
      assert.ok(configPath, `apps/${app} must have a Playwright config`);
      assert.equal(
        path.basename(configPath),
        'playwright.config.mts',
        `apps/${app}'s config must be .mts so it shares the ESM spec graph's module format`
      );
    }
  });

  // ---- CONTROLS: each predicate must report the defect it exists to catch ----

  it('CONTROL: reports a missing e2e manifest', () => {
    withFixture(
      {
        'apps/thing/e2e/a.test.ts': 'export const a = 1;\n',
        'apps/thing/package.json': '{"name":"thing"}',
        'package.json': '{"name":"root"}',
      },
      (root) => {
        const violations = findModuleFormatViolations(root);
        assert.equal(violations.length, 1);
        assert.match(violations[0], /apps\/thing\/e2e/);
        assert.match(violations[0], /does not declare "type": "module"/);
      }
    );
  });

  it('CONTROL: reports an e2e manifest that is not ESM', () => {
    withFixture(
      {
        'apps/thing/e2e/a.test.ts': 'export const a = 1;\n',
        'apps/thing/e2e/package.json': '{"type":"commonjs"}',
        'apps/thing/package.json': '{"name":"thing"}',
        'package.json': '{"name":"root"}',
      },
      (root) => {
        assert.equal(findModuleFormatViolations(root).length, 1);
      }
    );
  });

  it('CONTROL: accepts an e2e manifest that is ESM', () => {
    withFixture(
      {
        'apps/thing/e2e/a.test.ts': 'export const a = 1;\n',
        'apps/thing/e2e/package.json': '{"type":"module"}',
        'apps/thing/package.json': '{"name":"thing"}',
        'package.json': '{"name":"root"}',
      },
      (root) => {
        assert.deepEqual(findModuleFormatViolations(root), []);
      }
    );
  });

  it('CONTROL: reports an escaping import whose target uses import.meta', () => {
    withFixture(
      {
        'apps/thing/e2e/a.test.ts': "import { u } from '../src/leaky';\nexport const a = u;\n",
        'apps/thing/e2e/package.json': '{"type":"module"}',
        'apps/thing/package.json': '{"name":"thing"}',
        'apps/thing/src/leaky.ts': 'export const u = import.meta.url;\n',
        'package.json': '{"name":"root"}',
      },
      (root) => {
        const violations = findEscapingImportViolations(root);
        assert.equal(violations.length, 1);
        assert.match(violations[0], /import\.meta/);
      }
    );
  });

  it('CONTROL: reports an escaping import whose target uses export *', () => {
    withFixture(
      {
        'apps/thing/e2e/a.test.ts': "import { u } from '../src/barrel';\nexport const a = u;\n",
        'apps/thing/e2e/package.json': '{"type":"module"}',
        'apps/thing/package.json': '{"name":"thing"}',
        'apps/thing/src/barrel.ts': "export * from './other.js';\n",
        'apps/thing/src/other.ts': 'export const u = 1;\n',
        'package.json': '{"name":"root"}',
      },
      (root) => {
        const violations = findEscapingImportViolations(root);
        assert.equal(violations.length, 1);
        assert.match(violations[0], /export \*/);
      }
    );
  });

  it('CONTROL: reports an escaping import whose target has a runtime dependency', () => {
    withFixture(
      {
        'apps/thing/e2e/a.test.ts': "import { u } from '../src/leaky';\nexport const a = u;\n",
        'apps/thing/e2e/package.json': '{"type":"module"}',
        'apps/thing/package.json': '{"name":"thing"}',
        'apps/thing/src/leaky.ts':
          "import { createLogger } from '@brainstrike/logging';\nexport const u = createLogger('u');\n",
        'package.json': '{"name":"root"}',
      },
      (root) => {
        const violations = findEscapingImportViolations(root);
        assert.equal(violations.length, 1);
        assert.match(violations[0], /runtime bare dependencies/);
        assert.match(violations[0], /@brainstrike\/logging/);
      }
    );
  });

  it('CONTROL: reports a transitive runtime dependency beyond an escaping import', () => {
    withFixture(
      {
        'apps/thing/e2e/a.test.ts': "import { u } from '../src/leaf';\nexport const a = u;\n",
        'apps/thing/e2e/package.json': '{"type":"module"}',
        'apps/thing/package.json': '{"name":"thing"}',
        'apps/thing/src/leaf.ts': "import { value } from './sibling';\nexport const u = value;\n",
        'apps/thing/src/sibling.ts':
          "import './leaf';\nimport { createLogger } from '@brainstrike/logging';\nexport const value = createLogger('u');\n",
        'package.json': '{"name":"root"}',
      },
      (root) => {
        const violations = findEscapingImportViolations(root);
        assert.equal(violations.length, 1);
        assert.match(violations[0], /apps\/thing\/src\/sibling\.ts/);
        assert.match(violations[0], /@brainstrike\/logging/);
      }
    );
  });

  it('ignores type-only dependencies when identifying runtime static edges', () => {
    assert.deepEqual(
      extractRuntimeStaticSpecifiers(
        "import type { Thing } from '@brainstrike/types';\nexport type { Other } from './other';\nexport const value = 1;\n"
      ),
      []
    );
  });

  it('CONTROL: allows an escaping import whose target has plain named exports', () => {
    withFixture(
      {
        'apps/thing/e2e/a.test.ts': "import { u } from '../src/plain';\nexport const a = u;\n",
        'apps/thing/e2e/package.json': '{"type":"module"}',
        'apps/thing/package.json': '{"name":"thing"}',
        'apps/thing/src/plain.ts': "export const u = 'ok';\n",
        'package.json': '{"name":"root"}',
      },
      (root) => {
        assert.deepEqual(findEscapingImportViolations(root), []);
      }
    );
  });

  it('CONTROL: allows an escaping import into another ESM manifest', () => {
    withFixture(
      {
        'apps/thing/e2e/a.test.ts':
          "import { u } from '../../../packages/lib/src/barrel';\nexport const a = u;\n",
        'apps/thing/e2e/package.json': '{"type":"module"}',
        'apps/thing/package.json': '{"name":"thing"}',
        'package.json': '{"name":"root"}',
        'packages/lib/package.json': '{"name":"lib","type":"module"}',
        'packages/lib/src/barrel.ts': "export * from './other.js';\n",
        'packages/lib/src/other.ts': 'export const u = 1;\n',
      },
      (root) => {
        assert.deepEqual(findEscapingImportViolations(root), []);
      }
    );
  });

  it('CONTROL: reports a CommonJS Playwright config beside an ESM e2e root', () => {
    withFixture(
      {
        'apps/thing/e2e/a.test.ts': 'export const a = 1;\n',
        'apps/thing/e2e/package.json': '{"type":"module"}',
        'apps/thing/package.json': '{"name":"thing"}',
        'apps/thing/playwright.config.ts': 'export default {};\n',
        'package.json': '{"name":"root"}',
      },
      (root) => {
        const violations = findConfigFormatViolations(root);
        assert.equal(violations.length, 1);
        assert.match(violations[0], /is CommonJS while/);
        assert.match(violations[0], /Rename the config to \.mts/);
      }
    );
  });

  it('CONTROL: accepts a .mts Playwright config beside an ESM e2e root', () => {
    withFixture(
      {
        'apps/thing/e2e/a.test.ts': 'export const a = 1;\n',
        'apps/thing/e2e/package.json': '{"type":"module"}',
        'apps/thing/package.json': '{"name":"thing"}',
        'apps/thing/playwright.config.mts': 'export default {};\n',
        'package.json': '{"name":"root"}',
      },
      (root) => {
        assert.deepEqual(findConfigFormatViolations(root), []);
      }
    );
  });

  it('CONTROL: accepts a .ts Playwright config under an ESM app manifest', () => {
    withFixture(
      {
        'apps/thing/e2e/a.test.ts': 'export const a = 1;\n',
        'apps/thing/package.json': '{"name":"thing","type":"module"}',
        'apps/thing/playwright.config.ts': 'export default {};\n',
        'package.json': '{"name":"root"}',
      },
      (root) => {
        assert.deepEqual(findModuleFormatViolations(root), []);
        assert.deepEqual(findConfigFormatViolations(root), []);
      }
    );
  });

  // ---- predicate-level behaviour ----

  it('detects export * only in real export positions', () => {
    assert.ok(hasStarReexport("export * from './x.js';"));
    assert.ok(hasStarReexport("export * as ns from './x.js';"));
    assert.ok(!hasStarReexport("// export * from './x.js';"));
    assert.ok(!hasStarReexport('const s = "export * from \'./x.js\'";'));
    assert.ok(!hasStarReexport("export { a } from './x.js';"));
  });

  it('detects import.meta only outside comments and strings', () => {
    assert.ok(hasImportMeta('const u = import.meta.url;'));
    assert.ok(hasImportMeta('const e = import.meta.env?.MODE;'));
    assert.ok(!hasImportMeta('// import.meta is unavailable here'));
    assert.ok(!hasImportMeta('throw new Error("import.meta outside a module");'));
    assert.ok(!hasImportMeta('const x = thing.import.meta;'));
  });

  it('extracts runtime static specifiers and ignores comments and type-only edges', () => {
    const source = [
      "import { a } from './a';",
      "import type { B } from '../b.js';",
      "export { c } from './c';",
      "import './side-effect';",
      "import pkg from '@scope/pkg';",
      "// import { d } from './d';",
    ].join('\n');

    assert.deepEqual(extractRuntimeStaticSpecifiers(source).sort(), [
      './a',
      './c',
      './side-effect',
      '@scope/pkg',
    ]);
  });

  it('finds the nearest manifest walking up, stopping at the root', () => {
    withFixture(
      {
        'apps/thing/e2e/nested/deep/file.ts': 'export const a = 1;\n',
        'apps/thing/package.json': '{"name":"thing"}',
        'package.json': '{"name":"root"}',
      },
      (root) => {
        const found = findNearestPackageJson(path.join(root, 'apps/thing/e2e/nested/deep'), root);
        assert.equal(path.relative(root, found), path.join('apps', 'thing', 'package.json'));
      }
    );
  });
});
