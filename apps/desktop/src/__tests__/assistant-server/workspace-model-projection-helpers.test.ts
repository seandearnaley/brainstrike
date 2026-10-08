import {
  clipProjectionEnd,
  clipProjectionMiddle,
  decodedWorkspaceTextModelOutputChars,
  escapeProjectionPathLineBreaks,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  makeWorkspaceTextModelOutput,
  PROJECTION_ENVELOPE_RESERVE_CHARS,
  projectionSingleLine,
} from '@brainstrike/host-capabilities/native-tools';
import { describe, expect, it } from 'vitest';

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
    expect(decodedWorkspaceTextModelOutputChars(['alpha', 'beta'])).toBe(
      Array.from(output.value).length + PROJECTION_ENVELOPE_RESERVE_CHARS
    );

    const newlineDenseLines = ['a\nb', 'c'];
    const newlineDenseOutput = makeWorkspaceTextModelOutput(newlineDenseLines);
    const decodedChars = decodedWorkspaceTextModelOutputChars(newlineDenseLines);
    const oldSerializedChars = JSON.stringify(newlineDenseOutput).length;

    expect(newlineDenseOutput.value).toBe('a\nb\nc');
    expect(decodedChars).toBe(31);
    expect(oldSerializedChars).toBe(33);
    expect(decodedChars).toBeLessThan(oldSerializedChars);
  });
});
