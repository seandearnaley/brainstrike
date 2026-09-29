import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract/tool-metadata';
import { describe, expect, it } from 'vitest';
import { resolveCardStatus, resolveErrorMessage } from '../tool-fallback-state';

/**
 * Seam test for `tool-fallback-state.ts` (BST-1684 review follow-through,
 * Minor 5): the pure state derivations the card mounts on top of, exercised
 * directly with no component tree. Mirrors the behaviour already pinned by
 * `tool-fallback.test.tsx` — no new wording invented here.
 */
describe('resolveCardStatus', () => {
  it('reads a generic settled non-run_python result as done, with no structured surface', () => {
    const { glyphState, runPythonResult } = resolveCardStatus(
      'brainstrike.readWorkspaceFile',
      { type: 'complete' },
      { ok: true },
      false
    );
    expect(glyphState).toBe('done');
    expect(runPythonResult).toBeNull();
  });

  it("overrides the generic reading with run_python's own narrowing under the identity rule", () => {
    // A stopped-without-completing run_python payload reads `cancelled`, not
    // the generic `done` — and because that narrowed reading is what PRODUCED
    // the glyph state, the structured surface is attached too (the identity
    // check in `resolveCardStatus`'s doc comment).
    const result = {
      kind: 'cancelled',
      partialStderr: '',
      partialStdout: '',
      stderrOmittedBytes: 0,
      stdoutOmittedBytes: 0,
    };
    const { glyphState, runPythonResult } = resolveCardStatus(
      NATIVE_TOOL_ID.runPython,
      { type: 'complete' },
      result,
      false
    );
    expect(glyphState).toBe('cancelled');
    expect(runPythonResult).not.toBeNull();
  });

  it('leaves a non-run_python tool on the generic reading even with a run_python-shaped result', () => {
    // Gated on the tool NAME: an MCP tool free to return `{kind:
    // 'unavailable'}` as ordinary domain data must not inherit run_python's
    // destructive reading, and must not surface the structured pane either.
    const { glyphState, runPythonResult } = resolveCardStatus(
      'booking.reserve',
      { type: 'complete' },
      { detail: 'seat taken', kind: 'unavailable', reason: 'busy' },
      false
    );
    expect(glyphState).toBe('done');
    expect(runPythonResult).toBeNull();
  });

  it('reads a declined call as cancelled — never the green Completed', () => {
    const { glyphState, runPythonResult } = resolveCardStatus(
      'brainstrike.executeCommand',
      { type: 'complete' },
      {
        kind: 'declined',
        message: 'The user declined this tool call, so it was not executed.',
      },
      false
    );
    expect(glyphState).toBe('cancelled');
    expect(runPythonResult).toBeNull();
  });
});

describe('resolveErrorMessage', () => {
  it('composes the incomplete-status message from its reason when no other detail exists', () => {
    expect(resolveErrorMessage({ reason: 'error', type: 'incomplete' }, undefined, false)).toBe(
      'Tool incomplete: error'
    );
  });

  it("renders the result's own stated error verbatim", () => {
    expect(resolveErrorMessage({ type: 'complete' }, { error: 'boom' }, false)).toBe('boom');
  });

  it('returns undefined when the result states no error and the part carries none', () => {
    expect(resolveErrorMessage({ type: 'complete' }, { ok: true }, false)).toBeUndefined();
  });
});
