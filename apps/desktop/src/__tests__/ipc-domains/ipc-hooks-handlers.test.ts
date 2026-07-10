import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256OfFile } from '../../assistant-server/hooks/trust';
import { getProjectHooksForReview } from '../../ipc-hooks-handlers';

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

let tmpRoot: string;

function writeProjectHooksBytes(rootAbsPath: string, bytes: Buffer): string {
  const dir = join(rootAbsPath, '.brainstrike');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'hooks.json');
  writeFileSync(file, bytes);
  return file;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'bs-hooks-review-'));
});

afterEach(() => {
  rmSync(tmpRoot, { force: true, recursive: true });
});

describe('getProjectHooksForReview', () => {
  it('rejects a non-absolute root path', () => {
    const result = getProjectHooksForReview('r1', 'relative/path', {
      readFile: () => Buffer.alloc(0),
    });
    expect(result.error).toMatch(/absolute/);
    expect(result.exists).toBe(false);
  });

  it('rejects an empty rootId', () => {
    const result = getProjectHooksForReview('', '/abs', { readFile: () => Buffer.alloc(0) });
    expect(result.error).toMatch(/rootId/);
  });

  it('reports exists:false when the file is missing', () => {
    const result = getProjectHooksForReview('r1', '/abs/root', {
      readFile: () => {
        throw new Error('ENOENT');
      },
    });
    expect(result.exists).toBe(false);
    expect(result.path).toBe('/abs/root/.brainstrike/hooks.json');
    expect(result.content).toBeUndefined();
  });

  it('returns content + sha256 for a valid file', () => {
    const content = '{"PreToolUse":[]}';
    const result = getProjectHooksForReview('r1', '/abs/root', {
      readFile: () => Buffer.from(content, 'utf8'),
    });
    expect(result.exists).toBe(true);
    expect(result.content).toBe(content);
    expect(result.sha256).toBe(sha256(content));
    expect(result.parseError).toBeUndefined();
  });

  it('surfaces a parseError for malformed JSON but still returns content + hash', () => {
    const content = '{ not json';
    const result = getProjectHooksForReview('r1', '/abs/root', {
      readFile: () => Buffer.from(content, 'utf8'),
    });
    expect(result.exists).toBe(true);
    expect(result.content).toBe(content);
    expect(result.sha256).toBe(sha256(content));
    expect(result.parseError).toBeDefined();
  });

  // M1: the review (approve-time) hash MUST be byte-identical to the server
  // trust-time hash (`sha256OfFile`). If the review hashed the utf8-DECODED
  // string while trust hashed the raw bytes, a file with non-utf8 bytes would
  // diverge → an approved root would be treated as untrusted and its hooks would
  // SILENTLY never run. Hash the RAW BYTES on both sides.
  it('hashes the raw file bytes, byte-identically to sha256OfFile (non-utf8 safe)', () => {
    // A lone 0xFF byte inside a JSON string is invalid UTF-8: readFileSync(utf8)
    // lossily maps it to U+FFFD, so a decoded-string hash diverges from the raw
    // byte hash. Placed inside a string value so the file still parses as JSON.
    const prefix = Buffer.from('{"PreToolUse":[{"command":"exit 2","description":"x', 'utf8');
    const suffix = Buffer.from('y","type":"command"}]}', 'utf8');
    const bytes = Buffer.concat([prefix, Buffer.from([0xff]), suffix]);
    const file = writeProjectHooksBytes(tmpRoot, bytes);

    const review = getProjectHooksForReview('r1', tmpRoot);

    expect(review.exists).toBe(true);
    expect(review.parseError).toBeUndefined();
    expect(review.sha256).toBe(sha256OfFile(file));
    // And it must NOT equal the (buggy) utf8-decoded-then-reencoded hash.
    expect(review.sha256).not.toBe(sha256(bytes.toString('utf8')));
  });
});
