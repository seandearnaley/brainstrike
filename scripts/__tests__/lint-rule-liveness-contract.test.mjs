// Lint-rule LIVENESS contract.
//
// Why this exists (BST-1220, #2372): `react-doctor/only-export-components` was
// documented as an enforced contract, cited in a dozen source files, and used
// to justify real module splits — while reporting 0 findings, because the id
// exists ONLY in react-doctor's oxlint→react-doctor alias table with no rule
// implementation behind it. react-doctor accepts an unknown rule id in
// `doctor.config.ts` SILENTLY, so a config that believes it enabled a rule is
// indistinguishable from one that did not.
//
// A zero finding count is therefore ambiguous: it means either "the codebase is
// clean" or "the rule is gone". These tests remove the ambiguity by feeding a
// KNOWN violation through the repo's real flat config and asserting the rule
// fires. If a rule is renamed, dropped, or degraded to an alias-only id, this
// goes red instead of reading as a clean run.
//
// Add a case here for any rule whose silent disappearance would be a false
// green — i.e. a rule the docs or source comments treat as a contract.

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

// Paths must match a `files` glob in eslint.config.js and must NOT match its
// `ignores` (no `__tests__/`, no `*.test.*`). Nothing is written to disk —
// lintText only uses the path to resolve config.
const FIXTURE_PATH = path.join(repoRoot, 'packages/ui/src/lint-rule-liveness-fixture.tsx');

// One instance, shared by every case: constructing ESLint re-reads and re-links
// the flat config, which is the slow part. All cases lint against the same
// shipping config, so a fresh instance per case buys nothing.
const eslint = new ESLint({ cwd: repoRoot });

/**
 * Lint a source string as if it were a real file at `filePath`, using the
 * repository's own eslint.config.js (not a synthetic config — the point is to
 * prove the SHIPPING configuration still enforces the rule).
 */
async function lintFixture(code) {
  const results = await eslint.lintText(code, { filePath: FIXTURE_PATH });
  return results.flatMap((result) => result.messages);
}

const CASES = [
  {
    // The Fast Refresh module-boundary contract. Cited by module splits in
    // packages/assistant-ui, packages/app-shell, packages/settings-ui, and
    // packages/file-explorer-ui. See docs/agents/ci-quality.md.
    // A plain exported function beside a component is the canonical violation:
    // re-evaluating the module gives it a new identity, so Vite's
    // validateRefreshBoundaryAndEnqueueUpdate rejects the boundary.
    code: [
      'export function helperThatBreaksTheBoundary() {',
      '  return 1;',
      '}',
      'export function SomeComponent() {',
      '  return null;',
      '}',
      '',
    ].join('\n'),
    name: 'Fast Refresh boundary rule fires on a non-component export',
    ruleId: 'react-refresh/only-export-components',
    // Intentionally 'warn': the 155-warning backlog rides the ratchet. If this
    // ever reads 'error' here, the backlog was burned down and the rule
    // promoted — update this and drop it from the baseline map.
    severity: 1,
  },
  {
    // Guards the one rule in this config set to 'error'. It is the reason the
    // eslint gate is a required check at all, so its silent loss would be the
    // most expensive false green here.
    code: [
      'export function SomeComponent({ flag }: { flag: boolean }) {',
      '  if (flag) {',
      '    useState(0);',
      '  }',
      '  return null;',
      '}',
      '',
    ].join('\n'),
    name: 'rules-of-hooks fires on a conditional hook call',
    ruleId: 'react-hooks/rules-of-hooks',
    // MUST stay 2 ('error'). Presence alone is not enough: an 'error'→'warn'
    // downgrade keeps the finding reported, so a presence-only assertion still
    // passes while the finding is absorbed into the --max-warnings slack and
    // `lint:eslint` exits 0. The gate would stop blocking with nothing red.
    severity: 2,
  },
];

for (const { code, name, ruleId, severity } of CASES) {
  test(`${name} (${ruleId})`, async () => {
    const messages = await lintFixture(code);

    // A rule that ESLint cannot resolve produces a fatal parse-style error
    // rather than silence, so surface that distinctly from "rule went dark".
    const fatal = messages.filter((message) => message.fatal);
    assert.deepEqual(
      fatal.map((message) => message.message),
      [],
      'fixture failed to lint; fix the fixture before trusting this contract'
    );

    const hits = messages.filter((message) => message.ruleId === ruleId);
    assert.ok(
      hits.length > 0,
      `${ruleId} produced no findings on a known violation. The rule is not ` +
        'running. A zero finding count from this rule elsewhere means "gone", ' +
        'not "clean" — do not read it as a passing gate. Rules observed: ' +
        `${JSON.stringify([...new Set(messages.map((m) => m.ruleId))])}`
    );

    // Severity, not just presence. A silent 'error'→'warn' downgrade leaves the
    // finding reported (so the check above still passes) while removing its
    // ability to fail the build — the warning simply joins the ratchet backlog.
    assert.deepEqual(
      [...new Set(hits.map((hit) => hit.severity))],
      [severity],
      `${ruleId} fired at the wrong severity. Expected ${severity} ` +
        `(${severity === 2 ? 'error' : 'warn'}). A downgrade to 'warn' is ` +
        'absorbed by --max-warnings and stops blocking; an upgrade to ' +
        "'error' means the backlog was burned down — update this case."
    );
  });
}

test('the liveness fixture path is actually linted by the repo config', async () => {
  // Guards the setup itself: if eslint.config.js `files`/`ignores` ever stop
  // covering FIXTURE_PATH, every case above would lint to zero messages and
  // could be "fixed" by loosening the assertions instead of the config.
  assert.equal(
    await eslint.isPathIgnored(FIXTURE_PATH),
    false,
    `${FIXTURE_PATH} is ignored by eslint.config.js; pick a fixture path that ` +
      'matches a `files` glob and no `ignores` entry'
  );
});
