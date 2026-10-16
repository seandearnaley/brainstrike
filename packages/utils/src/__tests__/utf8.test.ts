import { describe, expect, it } from 'vitest';
import { utf8ByteLength, utf8Decode } from '../utf8.js';

describe('utf8ByteLength', () => {
  it.each([
    ['empty', ''],
    ['ASCII', 'plain text\n'],
    ['two-byte', 'café ñ'],
    ['three-byte', '中文 €'],
    ['astral', '🧠 𝄞'],
    ['lone high surrogate', 'a\uD83Db'],
    ['lone low surrogate', 'a\uDE00b'],
    ['trailing high surrogate', 'end\uD83D'],
    ['reversed pair', '\uDE00\uD83D'],
    ['large', `${'x'.repeat(100_000)}🧠`],
  ])('counts %s as Buffer.byteLength does', (_name, text) => {
    expect(utf8ByteLength(text)).toBe(Buffer.byteLength(text, 'utf8'));
  });
});

describe('utf8Decode', () => {
  it('decodes as Buffer does, malformed sequences and a leading BOM included', () => {
    const cases = [
      [0xef, 0xbb, 0xbf, 0x61],
      [0xff],
      [0xc0, 0x80],
      [0xed, 0xa0, 0x80],
      [0xf0, 0x9f, 0x98],
      [0x61, 0xe2, 0x82],
      [0xf0, 0x9f, 0xa7, 0xa0],
    ].map((bytes) => new Uint8Array(bytes));
    // A seeded walk over short byte strings, weighted toward multi-byte lead bytes.
    let seed = 1;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let i = 0; i < 20_000; i++) {
      const bytes = new Uint8Array(1 + Math.floor(next() * 10));
      for (let j = 0; j < bytes.length; j++) {
        bytes[j] = next() < 0.3 ? 0xe0 + Math.floor(next() * 21) : Math.floor(next() * 256);
      }
      cases.push(bytes);
    }
    for (const bytes of cases) {
      expect(utf8Decode(bytes)).toBe(Buffer.from(bytes).toString('utf8'));
    }
  });
});
