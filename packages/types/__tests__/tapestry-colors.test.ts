import { describe, expect, it } from 'vitest';
import {
  resolveTapestryColorHex,
  TAPESTRY_COLOR_HEX,
  TAPESTRY_COLOR_NAMES,
} from '../src/tapestry-colors';

describe('tapestry-colors', () => {
  it('maps every name to a 6-digit hex', () => {
    for (const name of TAPESTRY_COLOR_NAMES) {
      expect(TAPESTRY_COLOR_HEX[name]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('resolveTapestryColorHex returns the mapped hex or undefined', () => {
    expect(resolveTapestryColorHex('blue')).toBe('#3b82f6');
    expect(resolveTapestryColorHex(undefined)).toBeUndefined();
    // @ts-expect-error invalid name is rejected at the type level
    expect(resolveTapestryColorHex('chartreuse')).toBeUndefined();
  });

  it('exposes the 9 expected names', () => {
    expect([...TAPESTRY_COLOR_NAMES]).toEqual([
      'red',
      'orange',
      'yellow',
      'green',
      'cyan',
      'blue',
      'purple',
      'pink',
      'gray',
    ]);
  });
});
