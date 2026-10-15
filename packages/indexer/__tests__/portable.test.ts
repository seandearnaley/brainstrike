import { createHash } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as native from '../src/portable.js';

/** `portable.ts` as a runtime without Node's builtins loads it: the browser writer. */
async function withoutNodeBuiltins(): Promise<typeof native> {
  vi.resetModules();
  const original = process.getBuiltinModule;
  Object.defineProperty(process, 'getBuiltinModule', { configurable: true, value: undefined });
  try {
    return await import('../src/portable.js');
  } finally {
    Object.defineProperty(process, 'getBuiltinModule', { configurable: true, value: original });
  }
}

afterEach(() => {
  vi.resetModules();
});

const samples = [
  '',
  'sqlite index',
  JSON.stringify(['root-a', 'file-1', 'src/a.ts', 2]),
  'héllo wörld ✓ 𝄞',
  '\ud800 lone surrogate',
  'x'.repeat(100_000),
];

describe('the portable helpers', () => {
  it("hash exactly as Node's crypto does, natively and without Node", async () => {
    const browser = await withoutNodeBuiltins();
    for (const text of samples) {
      const expected = createHash('sha256').update(text).digest('hex');
      expect(native.sha256Hex(text)).toBe(expected);
      expect(browser.sha256Hex(text)).toBe(expected);
      expect(Buffer.from(browser.sha256Bytes(text)).toString('hex')).toBe(expected);
    }
  });

  it('read a source name as path.basename does on posix, without Node', async () => {
    const browser = await withoutNodeBuiltins();
    for (const source of ['/a/b/c.ts', 'c.ts', '/a/b/', 'a//b']) {
      expect(browser.basenameOfSource(source)).toBe(path.posix.basename(source));
      expect(browser.basenamePosix(source)).toBe(path.posix.basename(source));
    }
  });

  it('write and read float32 vectors as little-endian bytes', () => {
    const values = [1, -0.5, 3.25, 1e-7];
    const bytes = native.float32Bytes(values);
    expect(bytes).toEqual(new Uint8Array(Float32Array.from(values).buffer));
    expect(values.map((_, index) => native.float32At(bytes, index))).toEqual(
      Array.from(Float32Array.from(values))
    );
  });
});
