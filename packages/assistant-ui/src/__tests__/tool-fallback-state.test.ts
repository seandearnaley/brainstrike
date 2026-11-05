// @vitest-environment node
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract/tool-metadata';
import { describe, expect, it } from 'vitest';
import {
  formatToolArguments,
  formatToolResult,
  resolveCardStatus,
  resolveErrorMessage,
} from '../tool-fallback-state';

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

  it("reads an incomplete status error's own message rather than its JSON", () => {
    expect(
      resolveErrorMessage(
        {
          error: { code: 'E_TIMEOUT', message: 'Timed out after 30s' },
          reason: 'error',
          type: 'incomplete',
        },
        undefined,
        false
      )
    ).toBe('Timed out after 30s');
    expect(
      resolveErrorMessage(
        { error: { code: 'E_TIMEOUT' }, reason: 'error', type: 'incomplete' },
        undefined,
        false
      )
    ).toBe('{"code":"E_TIMEOUT"}');
  });

  it("renders the result's own stated error verbatim", () => {
    expect(resolveErrorMessage({ type: 'complete' }, { error: 'boom' }, false)).toBe('boom');
  });

  it('returns undefined when the result states no error and the part carries none', () => {
    expect(resolveErrorMessage({ type: 'complete' }, { ok: true }, false)).toBeUndefined();
  });
});

describe('formatToolArguments', () => {
  it('indents compact JSON text, as streamed tool arguments arrive', () => {
    expect(formatToolArguments('{"path":"src/app.ts","limit":2}')).toBe(
      '{\n  "path": "src/app.ts",\n  "limit": 2\n}'
    );
  });

  it('keeps a string argument that holds JSON a string', () => {
    expect(formatToolArguments('{"content":"{\\"name\\":\\"x\\"}"}')).toBe(
      '{\n  "content": "{\\"name\\":\\"x\\"}"\n}'
    );
  });

  it('keeps numbers exactly as written', () => {
    expect(formatToolArguments('{"id":9223372036854775807,"price":1.50}')).toBe(
      '{\n  "id": 9223372036854775807,\n  "price": 1.50\n}'
    );
  });

  it('shows arguments still streaming exactly as they arrived', () => {
    expect(formatToolArguments('{"path":"src/ap')).toBe('{"path":"src/ap');
  });
});

describe('formatToolResult', () => {
  it('expands JSON held in a string inside a result, such as MCP text content', () => {
    const result = { content: [{ text: '{"items":[1,2]}', type: 'text' }] };
    expect(formatToolResult(result)).toBe(
      JSON.stringify({ content: [{ text: { items: [1, 2] }, type: 'text' }] }, null, 2)
    );
  });

  it('keeps numbers in nested JSON text exactly as written', () => {
    expect(formatToolResult('{"id":9223372036854775807}')).toBe(
      '{\n  "id": 9223372036854775807\n}'
    );
  });

  it('shows text that is not JSON exactly as it arrived', () => {
    expect(formatToolResult('total 8\n-rw-r--r-- a.ts')).toBe('total 8\n-rw-r--r-- a.ts');
    expect(formatToolResult({ note: '[draft] notes' })).toBe('{\n  "note": "[draft] notes"\n}');
  });
});
