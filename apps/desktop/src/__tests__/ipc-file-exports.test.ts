import fsPromises, { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileExportsIpcHandlers, SaveToDownloadsArgs } from '../ipc-file-exports-handlers';
import { ipcArgsDecoder } from '../platform/ipc-args';

const decodeSaveArgs = ipcArgsDecoder('file-exports:save-to-downloads', SaveToDownloadsArgs);

describe('createFileExportsIpcHandlers', () => {
  let downloadsDir: string;
  let handlers: ReturnType<typeof createFileExportsIpcHandlers>;

  beforeEach(async () => {
    downloadsDir = await mkdtemp(path.join(tmpdir(), 'bs-file-exports-'));
    handlers = createFileExportsIpcHandlers({ getDownloadsPath: () => downloadsDir });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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
    ['a path traversal', { bytes: new Uint8Array([1]), filename: '../escape.md' }],
    ['an absolute path', { bytes: new Uint8Array([1]), filename: '/etc/escape.md' }],
    ['a backslash separator', { bytes: new Uint8Array([1]), filename: 'a\\b.md' }],
    ['a dots-only name', { bytes: new Uint8Array([1]), filename: '..' }],
    ['a name with spaces', { bytes: new Uint8Array([1]), filename: 'my export.csv' }],
    [
      'a filename too long to carry the widest collision counter',
      { bytes: new Uint8Array([1]), filename: `${'a'.repeat(248)}.md` },
    ],
    ['a non-object payload', 'export.csv'],
    ['a null payload', null],
    ['missing bytes', { filename: 'export.csv' }],
    ['string bytes', { bytes: 'not bytes', filename: 'export.csv' }],
    ['a plain ArrayBuffer', { bytes: new ArrayBuffer(4), filename: 'export.csv' }],
  ])('refuses %s before the handler runs', (_label, payload) => {
    expect(() => decodeSaveArgs([payload])).toThrow(TypeError);
  });

  it('removes the partial file when the write fails after the exclusive claim', async () => {
    // Real open (so O_EXCL genuinely creates the file), failing writeFile —
    // the ENOSPC/I/O-error case where the claim exists but the bytes never
    // land. Restoring the spy lets the retry below use the untouched fs.
    const realOpen = fsPromises.open.bind(fsPromises);
    vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      const fileHandle = await realOpen(...(args as Parameters<typeof realOpen>));
      return {
        close: () => fileHandle.close(),
        writeFile: () => Promise.reject(new Error('ENOSPC: no space left on device')),
      } as unknown as Awaited<ReturnType<typeof realOpen>>;
    });

    const failed = await handlers.saveToDownloads({
      bytes: new Uint8Array([1]),
      filename: 'export.csv',
    });

    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('ENOSPC');
    // The partial file must not be stranded in Downloads…
    await expect(readFile(path.join(downloadsDir, 'export.csv'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    // …so a retry claims the ORIGINAL name, not a counter-suffixed one.
    vi.restoreAllMocks();
    const retried = await handlers.saveToDownloads({
      bytes: new TextEncoder().encode('retry'),
      filename: 'export.csv',
    });
    expect(retried).toEqual({ ok: true, path: path.join(downloadsDir, 'export.csv') });
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
