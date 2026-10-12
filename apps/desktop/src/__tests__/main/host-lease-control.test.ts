import { describe, expect, it } from 'vitest';
import { decodeHostLeaseControl, decodeHostLeaseParentMessage } from '../../host-lease-control';

describe('desktop-private host lifetime control', () => {
  it('decodes only a strict cooperative close', () => {
    expect(decodeHostLeaseControl({ method: 'close' })).toEqual({ method: 'close' });
    for (const input of [null, {}, { method: 'run' }, { method: 'close', token: 'hidden' }]) {
      expect(() => decodeHostLeaseControl(input)).toThrow(TypeError);
    }
  });
  it('extracts Electron MessageEvent.data and rejects a raw control envelope', () => {
    expect(
      decodeHostLeaseControl(
        decodeHostLeaseParentMessage({ data: { method: 'close' }, ports: [] }).data
      )
    ).toEqual({ method: 'close' });
    expect(() => decodeHostLeaseParentMessage({ method: 'close' })).toThrow(TypeError);
  });
});
