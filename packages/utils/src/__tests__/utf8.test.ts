import { describe, expect, it } from 'vitest';
import { utf8ByteLength } from '../utf8.js';

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
