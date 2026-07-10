import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256OfBuffer, sha256OfFile } from '../../../assistant-server/hooks/trust';

let tmpRoot: string;

function writeProjectHooks(rootAbsPath: string, content: string): string {
  const dir = join(rootAbsPath, '.brainstrike');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'hooks.json');
  writeFileSync(file, content, 'utf8');
  return file;
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'bs-hooks-trust-'));
});

afterEach(() => {
  rmSync(tmpRoot, { force: true, recursive: true });
});

describe('sha256OfBuffer', () => {
  it('hashes raw bytes (never a utf8-decoded string)', () => {
    // A lone 0xFF byte is invalid UTF-8: a decoded-string hash would diverge.
    const bytes = Buffer.from([0x7b, 0xff, 0x7d]);
    expect(sha256OfBuffer(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(sha256OfBuffer(bytes)).not.toBe(sha256(bytes.toString('utf8')));
  });
});

describe('sha256OfFile', () => {
  it('hashes an existing file and returns null for a missing one', () => {
    const content = '{"a":1}';
    const file = writeProjectHooks(tmpRoot, content);
    expect(sha256OfFile(file)).toBe(sha256(content));
    expect(sha256OfFile(join(tmpRoot, 'nope.json'))).toBeNull();
  });

  it('is byte-identical to sha256OfBuffer of the same file', () => {
    const bytes = Buffer.from([0x7b, 0xef, 0xbb, 0xbf, 0x7d]);
    const dir = join(tmpRoot, '.brainstrike');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'hooks.json');
    writeFileSync(file, bytes);
    expect(sha256OfFile(file)).toBe(sha256OfBuffer(bytes));
  });
});
