import {
  applyToolModelOutputProjections,
  MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET,
  ToolProjectionInputRejectedError,
} from '@brainstrike/agent';
import { describe, expect, it } from 'vitest';
import { projectExecuteCommandModelOutput } from '../../assistant-server/execute-command-model-projection';
import {
  type ExecuteCommandToolResult,
  TRUNCATION_HINT,
} from '../../assistant-server/execute-command-tool';

function resultFixture(
  overrides: Partial<ExecuteCommandToolResult> = {}
): ExecuteCommandToolResult {
  return {
    command: 'printf hello',
    cwd: '/workspace',
    durationMs: 45,
    exitCode: 0,
    rootId: 'root-a',
    rootName: 'workspace',
    signal: null,
    stderr: '',
    stdout: 'hello',
    timedOut: false,
    truncated: false,
    ...overrides,
  };
}

describe('projectExecuteCommandModelOutput', () => {
  it('projects a silent successful single-root command as compact plain text', () => {
    expect(
      projectExecuteCommandModelOutput(
        resultFixture({ command: 'true', durationMs: 45, stdout: '' })
      )
    ).toEqual({
      type: 'text',
      value: 'exec exit=0 0.0s\n(no output)',
    });
  });

  it('renders timed-out and killed flags together without coercing a null exit code', () => {
    expect(
      projectExecuteCommandModelOutput(
        resultFixture({
          command: 'sleep 30',
          exitCode: null,
          signal: 'SIGTERM',
          stdout: '',
          timedOut: true,
        })
      ).value
    ).toBe('exec exit=null 0.0s timed_out killed=SIGTERM\n(no output)');
  });

  it('renders the producer truncation hint verbatim as the final line', () => {
    const projected = projectExecuteCommandModelOutput(
      resultFixture({ hint: TRUNCATION_HINT, stdout: 'partial', truncated: true })
    );

    expect(projected.value).toBe(`exec exit=0 0.0s truncated\npartial\n${TRUNCATION_HINT}`);
    expect(projected.value.split('\n').at(-1)).toBe(TRUNCATION_HINT);
  });

  it.each([
    ['grep needle file.txt', 'no matches'],
    ['rg needle src', 'no matches'],
    ['diff before.txt after.txt', 'files differ'],
    ['/usr/bin/grep needle file.txt', 'no matches'],
    [String.raw`C:\Tools\RG.EXE needle src`, 'no matches'],
  ])('interprets %s exit 1 as %s', (command, interpretation) => {
    const projected = projectExecuteCommandModelOutput(
      resultFixture({ command, exitCode: 1, stdout: '' })
    );

    expect(projected.value).toBe(`exec exit=1 0.0s (${interpretation})\n(no output)`);
  });

  it.each([
    ['node script.js', 1],
    ['grep needle file.txt', 0],
    ['grep needle file.txt', 124],
    ['cd foo && grep needle file.txt', 1],
    ['FOO=bar grep needle file.txt', 1],
  ])('does not guess an interpretation for %s at exit %s', (command, exitCode) => {
    const projected = projectExecuteCommandModelOutput(
      resultFixture({ command, exitCode, stdout: '' })
    );

    expect(projected.value).toBe(`exec exit=${exitCode} 0.0s\n(no output)`);
  });

  it('renders stdout only verbatim', () => {
    expect(projectExecuteCommandModelOutput(resultFixture({ stdout: 'alpha\nbeta' })).value).toBe(
      'exec exit=0 0.0s\nalpha\nbeta'
    );
  });

  it('renders stderr only under a stderr section marker', () => {
    expect(
      projectExecuteCommandModelOutput(resultFixture({ stderr: 'failure\ndetail', stdout: '' }))
        .value
    ).toBe('exec exit=0 0.0s\n[stderr]\nfailure\ndetail');
  });

  it('renders stdout before the stderr section when both are present', () => {
    expect(
      projectExecuteCommandModelOutput(resultFixture({ stderr: 'warning', stdout: 'result' })).value
    ).toBe('exec exit=0 0.0s\nresult\n[stderr]\nwarning');
  });

  it('uses an unambiguous display name for a multi-root label', () => {
    expect(
      projectExecuteCommandModelOutput(
        resultFixture({ openRoots: 2, rootId: 'root-a', rootName: 'alpha' })
      ).value
    ).toBe('exec exit=0 0.0s root=alpha\nhello');
  });

  it('uses the root id when the display name is globally ambiguous', () => {
    expect(
      projectExecuteCommandModelOutput(
        resultFixture({
          ambiguousRootNames: ['twin'],
          openRoots: 2,
          rootId: 'root-a',
          rootName: 'Twin',
        })
      ).value
    ).toBe('exec exit=0 0.0s root=root-a\nhello');
  });

  it('omits an unusable ambiguous root label when no root id is available', () => {
    const legacyMultiRoot = {
      ...resultFixture(),
      ambiguousRootNames: ['twin'],
      openRoots: 2,
      rootName: 'Twin',
    } as Record<string, unknown>;
    Reflect.deleteProperty(legacyMultiRoot, 'rootId');

    expect(projectExecuteCommandModelOutput(legacyMultiRoot).value).toBe('exec exit=0 0.0s\nhello');
  });

  it.each([undefined, 1])('omits the root token when openRoots is %s', (openRoots) => {
    expect(
      projectExecuteCommandModelOutput(
        resultFixture({
          ...(openRoots === undefined ? {} : { openRoots }),
          rootId: 'root-a',
          rootName: 'alpha',
        })
      ).value
    ).toBe('exec exit=0 0.0s\nhello');
  });

  it('escapes line breaks in root labels without creating header lines', () => {
    const projected = projectExecuteCommandModelOutput(
      resultFixture({ openRoots: 2, rootName: 'evil\r\nroot\u2028name\u2029tail' })
    );

    expect(projected.value).toBe(
      `${String.raw`exec exit=0 0.0s root=evil\r\nroot\u2028name\u2029tail`}\nhello`
    );
    expect(projected.value.split('\n')).toHaveLength(2);
  });

  it('projects a legacy raw result without topology fields', () => {
    const legacy = { ...resultFixture() } as Record<string, unknown>;
    Reflect.deleteProperty(legacy, 'ambiguousRootNames');
    Reflect.deleteProperty(legacy, 'openRoots');
    Reflect.deleteProperty(legacy, 'rootId');

    expect(projectExecuteCommandModelOutput(legacy)).toEqual({
      type: 'text',
      value: 'exec exit=0 0.0s\nhello',
    });
  });

  it.each([
    undefined,
    'not a result',
    { error: 'Repeated call refused', ok: false, refused: true },
    (() => {
      const missingExitCode = { ...resultFixture() } as Record<string, unknown>;
      Reflect.deleteProperty(missingExitCode, 'exitCode');
      return missingExitCode;
    })(),
  ])('rejects malformed projection input with the typed marker', (malformed) => {
    expect(() => projectExecuteCommandModelOutput(malformed)).toThrow(
      ToolProjectionInputRejectedError
    );
  });

  it('keeps malformed results non-throwing through the runtime dispatcher', () => {
    const refusal = { error: 'Repeated call refused', ok: false, refused: true };
    const tools = applyToolModelOutputProjections(
      {
        executeCommand: {
          execute: () => refusal,
          id: 'brainstrike.executeCommand',
          toModelOutput: projectExecuteCommandModelOutput,
        } as never,
      },
      new Map([['executeCommand', 'brainstrike.executeCommand']])
    );

    const projection = (
      tools['executeCommand'] as { toModelOutput?: (value: unknown) => unknown }
    ).toModelOutput?.(refusal) as { type?: string; value?: string };

    expect(projection.type).toBe('text');
    expect(projection.value).toContain('refused');
  });

  it('throws a budget-naming RangeError instead of double-truncating stream content', () => {
    const oversized = resultFixture({
      stderr: 'e'.repeat(3500),
      stdout: 'o'.repeat(3500),
    });

    expect(() => projectExecuteCommandModelOutput(oversized)).toThrow(RangeError);
    expect(() => projectExecuteCommandModelOutput(oversized)).toThrow(
      String(MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET)
    );
  });

  it('replays its stored text projection byte-for-byte', () => {
    const first = projectExecuteCommandModelOutput(resultFixture());

    expect(projectExecuteCommandModelOutput(first)).toEqual(first);
  });

  it('rejects an oversized stored text projection', () => {
    expect(() =>
      projectExecuteCommandModelOutput({
        type: 'text',
        value: `exec ${'x'.repeat(MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET)}`,
      })
    ).toThrow(RangeError);
  });

  it('does not replay a text envelope with extra keys', () => {
    expect(() =>
      projectExecuteCommandModelOutput({
        extra: true,
        type: 'text',
        value: 'exec exit=0 0.0s\n(no output)',
      })
    ).toThrow(ToolProjectionInputRejectedError);
  });
});
