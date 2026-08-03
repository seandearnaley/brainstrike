import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileExportsIpcHandlers } from '../ipc-file-exports-handlers';

describe('createFileExportsIpcHandlers', () => {
  let downloadsDir: string;
  let handlers: ReturnType<typeof createFileExportsIpcHandlers>;

  beforeEach(async () => {
    downloadsDir = await mkdtemp(path.join(tmpdir(), 'bs-file-exports-'));
    handlers = createFileExportsIpcHandlers({ getDownloadsPath: () => downloadsDir });
  });

  afterEach(async () => {
    await rm(downloadsDir, { force: true, recursive: true });
  });

  it('writes the bytes to the Downloads folder and returns the path', async () => {
    const result = await handlers.saveToDownloads({
      bytes: new TextEncoder().encode('# bundle'),
      filename: 'brainstrike-debug-bundle-2026-08-03T10-00-00Z.md',
    });

    expect(result).toEqual({
      ok: true,
      path: path.join(downloadsDir, 'brainstrike-debug-bundle-2026-08-03T10-00-00Z.md'),
    });
    await expect(
      readFile(path.join(downloadsDir, 'brainstrike-debug-bundle-2026-08-03T10-00-00Z.md'), 'utf8')
    ).resolves.toBe('# bundle');
  });

  it('never overwrites: an existing file gets a Chromium-style " (n)" counter', async () => {
    await writeFile(path.join(downloadsDir, 'export.csv'), 'original');
    await writeFile(path.join(downloadsDir, 'export (1).csv'), 'first copy');

    const result = await handlers.saveToDownloads({
      bytes: new TextEncoder().encode('new'),
      filename: 'export.csv',
    });

    expect(result).toEqual({ ok: true, path: path.join(downloadsDir, 'export (2).csv') });
    await expect(readFile(path.join(downloadsDir, 'export.csv'), 'utf8')).resolves.toBe('original');
    await expect(readFile(path.join(downloadsDir, 'export (2).csv'), 'utf8')).resolves.toBe('new');
  });

  it('counters an extensionless filename with a plain tail', async () => {
    await writeFile(path.join(downloadsDir, 'export'), 'original');

    const result = await handlers.saveToDownloads({
      bytes: new Uint8Array([1]),
      filename: 'export',
    });

    expect(result).toEqual({ ok: true, path: path.join(downloadsDir, 'export (1)') });
  });

  it('refuses to write through a symlink squatting on the target name', async () => {
    const outsideTarget = path.join(downloadsDir, 'outside-target.txt');
    await writeFile(outsideTarget, 'outside');
    await symlink(outsideTarget, path.join(downloadsDir, 'export.csv'));

    const result = await handlers.saveToDownloads({
      bytes: new TextEncoder().encode('new'),
      filename: 'export.csv',
    });

    // O_EXCL fails EEXIST on the symlink itself, so the write lands on the
    // countered name instead of following the link.
    expect(result).toEqual({ ok: true, path: path.join(downloadsDir, 'export (1).csv') });
    await expect(readFile(outsideTarget, 'utf8')).resolves.toBe('outside');
  });

  it.each([
    ['a path traversal', '../escape.md'],
    ['an absolute path', '/etc/escape.md'],
    ['a backslash separator', 'a\\b.md'],
    ['a dots-only name', '..'],
    ['a name with spaces', 'my export.csv'],
  ])('rejects %s without writing', async (_label, filename) => {
    const result = await handlers.saveToDownloads({
      bytes: new Uint8Array([1]),
      filename,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('filename');
  });

  it('rejects an over-long filename', async () => {
    const result = await handlers.saveToDownloads({
      bytes: new Uint8Array([1]),
      filename: `${'a'.repeat(256)}.md`,
    });

    expect(result).toEqual({ error: 'file-exports filename exceeds 255 characters', ok: false });
  });

  it.each([
    ['a non-object payload', 'export.csv'],
    ['a null payload', null],
  ])('rejects %s', async (_label, payload) => {
    const result = await handlers.saveToDownloads(payload);

    expect(result).toEqual({
      error: 'file-exports saveToDownloads requires an object payload',
      ok: false,
    });
  });

  it.each([
    ['missing bytes', undefined],
    ['string bytes', 'not bytes'],
    ['a plain ArrayBuffer', new ArrayBuffer(4)],
  ])('rejects %s', async (_label, bytes) => {
    const result = await handlers.saveToDownloads({ bytes, filename: 'export.csv' });

    expect(result).toEqual({
      error: 'file-exports saveToDownloads requires Uint8Array bytes',
      ok: false,
    });
  });

  it('returns a structured error instead of throwing when the write fails', async () => {
    handlers = createFileExportsIpcHandlers({
      getDownloadsPath: () => path.join(downloadsDir, 'does-not-exist'),
    });

    const result = await handlers.saveToDownloads({
      bytes: new Uint8Array([1]),
      filename: 'export.csv',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('ENOENT');
  });
});
