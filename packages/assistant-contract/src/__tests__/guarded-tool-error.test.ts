import { describe, expect, it } from 'vitest';
import {
  GUARDED_TOOL_ERROR_CODES,
  isGuardedToolError,
  ToolInputError,
} from '../guarded-tool-error';

describe('isGuardedToolError', () => {
  it.each(GUARDED_TOOL_ERROR_CODES)('accepts the canonical %s code', (code) => {
    expect(
      isGuardedToolError({
        error: { code, message: 'failed', toolName: 'workspace.readFile' },
        ok: false,
      })
    ).toBe(true);
  });

  it('rejects unknown codes and successful payloads', () => {
    expect(
      isGuardedToolError({
        error: { code: 'tool_cancelled', message: 'cancelled', toolName: 'workspace.readFile' },
        ok: false,
      })
    ).toBe(false);
    expect(
      isGuardedToolError({
        error: { code: 'tool_failed', message: 'advisory', toolName: 'workspace.readFile' },
        ok: true,
      })
    ).toBe(false);
  });
});

describe('ToolInputError', () => {
  it('brands trusted model-correctable validation failures', () => {
    const error = new ToolInputError('Specify the root.');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ToolInputError');
    expect(error.code).toBe('tool_input_invalid');
    expect(error.message).toBe('Specify the root.');
  });
});
