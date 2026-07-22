import { describe, expect, it } from 'vitest';
import {
  clipProjectionEnd,
  clipProjectionMiddle,
  escapeProjectionPathLineBreaks,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  makeWorkspaceTextModelOutput,
  projectionSingleLine,
  serializedWorkspaceTextModelOutputChars,
} from '../../assistant-server/workspace-model-projection-helpers';

describe('workspace model projection helpers', () => {
  it('keeps strict shared guards producer-agnostic', () => {
    expect(isRecord({ value: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isNonNegativeInteger(0)).toBe(true);
    expect(isNonNegativeInteger(-1)).toBe(false);
    expect(isNonNegativeInteger(1.5)).toBe(false);
    expect(isPositiveInteger(1)).toBe(true);
    expect(isPositiveInteger(0)).toBe(false);
  });

  it('normalizes single-line text without changing explicit path escaping', () => {
    expect(projectionSingleLine('  alpha\n beta\t gamma  ')).toBe('alpha beta gamma');
    expect(escapeProjectionPathLineBreaks('dir  one\r\ntwo\u2028three\u2029four')).toBe(
      String.raw`dir  one\r\ntwo\u2028three\u2029four`
    );
  });

  it('clips by code point with the existing visible omission formats', () => {
    expect(clipProjectionEnd('  ab😀cd  ', 3, 'value')).toBe('ab😀…[2 value chars omitted]');
    expect(clipProjectionMiddle('ab😀cdef', 4, 'path')).toBe('ab…[3 path clipped]…ef');
  });

  it('builds and measures the shared Mastra text-output envelope', () => {
    const output = makeWorkspaceTextModelOutput(['alpha', 'beta']);

    expect(output).toEqual({ type: 'text', value: 'alpha\nbeta' });
    expect(serializedWorkspaceTextModelOutputChars(['alpha', 'beta'])).toBe(
      JSON.stringify(output).length
    );
  });
});
