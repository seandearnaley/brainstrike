import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { vectorBlob } from '../src/chunks.js';
import { validateStoredVectorBytes } from '../src/scoped-vector-validation.js';

interface StoredVector {
  readonly dimensions: number;
  readonly emb: Uint8Array;
}
function historicalValidation(row: StoredVector): void {
  if (row.emb.byteLength !== row.dimensions * 4) {
    throw new Error('Stored Float32 vector dimensions disagree.');
  }
  const emb = Buffer.from(row.emb);
  vectorBlob(Array.from({ length: row.dimensions }, (_, index) => emb.readFloatLE(index * 4)));
}
function outcome(work: () => void): { name: string; message: string } | null {
  try {
    work();
    return null;
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    return { message: error.message, name: error.name };
  }
}
function fromBits(bits: readonly number[]): StoredVector {
  const emb = Buffer.alloc(bits.length * 4);
  bits.forEach((value, index) => {
    emb.writeUInt32LE(value, index * 4);
  });
  return { dimensions: bits.length, emb };
}
const cases = [
  {
    bits: [0x3f_80_00_00, 0xbf_80_00_00, 0x7f_7f_ff_ff, 0xff_7f_ff_ff],
    name: 'signed normal limits',
    valid: true,
  },
  {
    bits: [0x00_00_00_01, 0x80_00_00_01, 0x00_7f_ff_ff, 0x80_7f_ff_ff],
    name: 'signed subnormals',
    valid: true,
  },
  { bits: [0x00_80_00_00, 0x80_80_00_00], name: 'smallest signed normals', valid: true },
  {
    bits: [0x00_00_00_00, 0x80_00_00_00, 0x00_00_00_01],
    name: 'signed zeros with a subnormal',
    valid: true,
  },
  { bits: [0x00_00_00_00, 0x80_00_00_00], name: 'only signed zeros', valid: false },
  { bits: [0x3f_80_00_00, 0x7f_c0_00_00], name: 'quiet NaN after a nonzero value', valid: false },
  { bits: [0x7f_80_00_01, 0x3f_80_00_00], name: 'signaling NaN', valid: false },
  { bits: [0x3f_80_00_00, 0xff_c1_23_45], name: 'negative NaN payload', valid: false },
  { bits: [0x3f_80_00_00, 0x7f_80_00_00], name: 'positive infinity', valid: false },
  { bits: [0xff_80_00_00, 0x3f_80_00_00], name: 'negative infinity', valid: false },
] as const;

describe('stored Float32 vector validation', () => {
  it.each(cases)('preserves historical acceptance and errors for $name', ({ bits, valid }) => {
    const row = fromBits(bits);
    const before = new Uint8Array(row.emb);
    const actual = outcome(() => validateStoredVectorBytes(row));
    expect(actual).toEqual(outcome(() => historicalValidation(row)));
    expect(actual).toEqual(
      valid
        ? null
        : { message: 'Embedding must remain finite and nonzero as float32.', name: 'TypeError' }
    );
    expect(Array.from(row.emb)).toEqual(Array.from(before));
  });

  it.each([0, 3, 7, 9, 12])('preserves the length error for %i stored bytes', (length) => {
    const row = { dimensions: 2, emb: new Uint8Array(length) };
    expect(outcome(() => validateStoredVectorBytes(row))).toEqual(
      outcome(() => historicalValidation(row))
    );
    expect(() => validateStoredVectorBytes(row)).toThrow(
      'Stored Float32 vector dimensions disagree.'
    );
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'retains positive integer dimension decoding for %s',
    (dimensions) => {
      expect(() => validateStoredVectorBytes({ dimensions, emb: new Uint8Array(8) })).toThrow(
        TypeError
      );
    }
  );

  it.each(['Uint8Array', 'Buffer'] as const)('checks only an unaligned %s span', (kind) => {
    const backing = kind === 'Buffer' ? Buffer.alloc(18, 0xff) : new Uint8Array(18).fill(0xff);
    backing.set(fromBits([0x00_00_00_00, 0x80_00_00_00, 0x00_00_00_01]).emb, 3);
    const row = { dimensions: 3, emb: backing.subarray(3, 15) };
    expect(row.emb.byteOffset).toBeGreaterThan(0);
    expect(outcome(() => validateStoredVectorBytes(row))).toBeNull();
    expect(outcome(() => validateStoredVectorBytes(row))).toEqual(
      outcome(() => historicalValidation(row))
    );
    backing.set(fromBits([0x00_00_00_00, 0x80_00_00_00, 0x00_00_00_00]).emb, 3);
    expect(outcome(() => validateStoredVectorBytes(row))).toEqual(
      outcome(() => historicalValidation(row))
    );
    expect(() => validateStoredVectorBytes(row)).toThrow('finite and nonzero');
  });

  it('accepts the recorded fused MiniLM Float32 vector', () => {
    const fixture: { profile: { dimensions: number }; vector: number[] } = JSON.parse(
      readFileSync(new URL('./fixtures/fused-minilm-384.json', import.meta.url), 'utf8')
    );
    const row = { dimensions: fixture.profile.dimensions, emb: vectorBlob(fixture.vector) };
    expect(outcome(() => validateStoredVectorBytes(row))).toBeNull();
    expect(outcome(() => validateStoredVectorBytes(row))).toEqual(
      outcome(() => historicalValidation(row))
    );
  });

  it.each([384, 1536, 3072])(
    'checks the final lane in a supported %i-dimension profile',
    (dimensions) => {
      const emb = Buffer.alloc(dimensions * 4);
      emb.writeUInt32LE(0x80_00_00_01, emb.byteLength - 4);
      expect(() => validateStoredVectorBytes({ dimensions, emb })).not.toThrow();
      emb.writeUInt32LE(0x7f_c0_00_00, emb.byteLength - 4);
      expect(() => validateStoredVectorBytes({ dimensions, emb })).toThrow('finite and nonzero');
    }
  );

  it('validates existing bytes without copying or re-encoding the blob', () => {
    const row = fromBits([0x3f_80_00_00, 0xbf_80_00_00]);
    const copy = vi.spyOn(Buffer, 'from');
    const allocation = vi.spyOn(Buffer, 'alloc');
    try {
      validateStoredVectorBytes(row);
      expect(copy).not.toHaveBeenCalled();
      expect(allocation).not.toHaveBeenCalled();
    } finally {
      copy.mockRestore();
      allocation.mockRestore();
    }
  });
});
