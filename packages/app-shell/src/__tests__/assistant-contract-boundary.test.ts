import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP_SHELL_SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_SHELL_PACKAGE_ROOT = path.resolve(APP_SHELL_SRC_ROOT, '..');

function readSource(relativePath: string): string {
  return readFileSync(path.join(APP_SHELL_SRC_ROOT, relativePath), 'utf8');
}

function readPackageFile(relativePath: string): string {
  return readFileSync(path.join(APP_SHELL_PACKAGE_ROOT, relativePath), 'utf8');
}

// assistant-data's own boundary suite (contract-boundary.test.ts there) now
// owns the moved data layer's import hygiene; this file guards app-shell only.
describe('app-shell assistant contract boundary', () => {
  it('reads provider and tool metadata from assistant-contract instead of agent runtime packages', () => {
    const wrapperSource = readSource('assistant-ui-panel-wrapper.tsx');

    expect(wrapperSource).not.toMatch(/@brainstrike\/agent\/provider-metadata/);
    expect(wrapperSource).not.toMatch(/@brainstrike\/agent\/tool-metadata/);
  });

  it('reads local-runtime metadata from assistant-contract instead of agent runtime packages', () => {
    expect(readSource('assistant-ui-panel-wrapper.tsx')).not.toMatch(
      /@brainstrike\/agent\/(?:client|local-runtime)/
    );
    expect(readSource('__tests__/assistant-ui-panel-wrapper.test.tsx')).not.toMatch(
      /@brainstrike\/agent\/(?:client|local-runtime)/
    );
  });

  it('reads runtime request metadata from assistant-contract instead of the agent root package', () => {
    expect(readSource('assistant-ui-panel-wrapper.tsx')).not.toMatch(/from '@brainstrike\/agent'/);
  });

  /**
   * SHRINK-ONLY COMPOSITION BUDGET (BST-1652 — do not turn this back into a cap).
   *
   * This budget used to be a ceiling with headroom, and it was bumped ~20 times
   * from 1,500 to 1,905, every bump justified as "the wrapper only adds ONE hook
   * call and ONE prop". The instrument was measuring the wrong thing: it
   * recorded the growth instead of resisting it, and it made the wrapper the
   * seam every new assistant feature had to cross. (The bump log is in this
   * file's git history; it is not worth carrying forward.)
   *
   * The rule now runs one way. The number below is the file's CURRENT size, not
   * an allowance:
   *
   *  - The file may not grow past it. If your change needs more lines in the
   *    wrapper, the change belongs somewhere else — a hook, a pure module under
   *    `src/assistant-panel/`, or the package that owns the behavior. Raising
   *    the number is not the fix; it is the failure this test exists to catch.
   *  - When the file legitimately shrinks, LOWER the number in the same commit.
   *    The budget is an EXACT pin, not a ceiling: shrinking below it fails just
   *    as growing past it does. A tolerance band would let a file shrink by a
   *    few lines without re-baselining, and a later change could then add those
   *    lines back while still passing — which is precisely the banked headroom
   *    this test exists to prevent.
   */
  const WRAPPER_LINE_BUDGET = 1245;
  const WRAPPER_TEST_LINE_BUDGET = 2044;

  function expectShrinkOnly(source: string, budget: number, label: string): void {
    const lineCount = source.split('\n').length;

    expect(
      lineCount,
      `${label} grew to ${lineCount} lines, past its shrink-only budget of ${budget}. ` +
        'Put the new code in a hook or module instead of raising this number.'
    ).toBeLessThanOrEqual(budget);

    expect(
      lineCount,
      `${label} shrank to ${lineCount} lines. Lower its budget from ${budget} to ${lineCount} ` +
        'in this same commit so the headroom cannot be spent on the next feature.'
    ).toBeGreaterThanOrEqual(budget);
  }

  it('keeps the assistant panel wrapper within a shrink-only source-file budget', () => {
    expectShrinkOnly(
      readSource('assistant-ui-panel-wrapper.tsx'),
      WRAPPER_LINE_BUDGET,
      'assistant-ui-panel-wrapper.tsx'
    );
  });

  it('keeps the assistant panel wrapper executable test within a shrink-only budget', () => {
    expectShrinkOnly(
      readSource('__tests__/assistant-ui-panel-wrapper.test.tsx'),
      WRAPPER_TEST_LINE_BUDGET,
      'assistant-ui-panel-wrapper.test.tsx'
    );
  });

  it('reads built-in local LLM availability from assistant-contract instead of agent runtime packages', () => {
    expect(readSource('hooks/use-assistant-availability-with-local.ts')).not.toMatch(
      /@brainstrike\/agent\/local-llm/
    );
    expect(readSource('__tests__/use-assistant-availability-with-local.test.ts')).not.toMatch(
      /@brainstrike\/agent\/local-llm/
    );
  });

  it('has no direct app-shell dependency on the agent runtime package', () => {
    const packageJson = JSON.parse(readPackageFile('package.json')) as {
      dependencies?: Record<string, string>;
    };

    expect(readSource('assistant-ui-panel-wrapper.tsx')).not.toMatch(/@brainstrike\/agent/);
    expect(readSource('__tests__/assistant-ui-panel-wrapper.test.tsx')).not.toMatch(
      /@brainstrike\/agent/
    );
    expect(packageJson.dependencies).not.toHaveProperty('@brainstrike/agent');
  });
});
