import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TRAVERSAL_LIMIT,
  expandHome,
  isPathInsideRoot,
  normalizeRootDir,
  resolveValidatedPath,
} from '../path-validation';

describe('resolveValidatedPath', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-validate-'));
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  it('resolves paths inside the configured root', async () => {
    const result = await resolveValidatedPath({
      rootDir: tempDir,
      requestedPath: '.',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(await fsPromises.realpath(tempDir));
    }
  });

  it('rejects null bytes', async () => {
    const result = await resolveValidatedPath({
      rootDir: tempDir,
      requestedPath: '/tmp/\0oops',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('null-byte');
    }
  });

  it('uses the fallback when the requested path is empty', async () => {
    const result = await resolveValidatedPath({
      rootDir: tempDir,
      requestedPath: '',
      fallbackPath: 'fallback-folder',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const rootReal = await fsPromises.realpath(tempDir);
      expect(result.path).toBe(path.join(rootReal, 'fallback-folder'));
    }
  });

  it('rejects when requested and fallback are blank', async () => {
    const result = await resolveValidatedPath({
      rootDir: tempDir,
      requestedPath: '   ',
      fallbackPath: ' ',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-input');
    }
  });

  it('rejects excessive traversal', async () => {
    const traversal = '../'.repeat(DEFAULT_TRAVERSAL_LIMIT + 1);
    const result = await resolveValidatedPath({
      rootDir: tempDir,
      requestedPath: traversal,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('traversal');
    }
  });

  it('rejects paths outside the root when missing', async () => {
    const result = await resolveValidatedPath({
      rootDir: tempDir,
      requestedPath: '../outside-root',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('outside-root');
    }
  });

  it('allows missing paths inside the root', async () => {
    const result = await resolveValidatedPath({
      rootDir: tempDir,
      requestedPath: 'missing-folder',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const rootReal = await fsPromises.realpath(tempDir);
      expect(result.path).toBe(path.join(rootReal, 'missing-folder'));
    }
  });

  it('rejects sensitive directories on unix', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const result = await resolveValidatedPath({
      requestedPath: '/etc/passwd',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('sensitive-path');
    }
  });

  it('rejects sensitive procfs directories on unix', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const result = await resolveValidatedPath({
      requestedPath: '/proc/self/cmdline',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('sensitive-path');
    }
  });

  it('rejects sensitive user directories', async () => {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'];
    if (!home) {
      return;
    }

    const sensitivePath = path.join(home, '.ssh', 'id_rsa');
    const result = await resolveValidatedPath({
      requestedPath: sensitivePath,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('sensitive-path');
    }
  });

  it('rejects sensitive user directories (exact match)', async () => {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'];
    if (!home) {
      return;
    }

    const sensitivePath = path.join(home, '.aws');
    const result = await resolveValidatedPath({
      requestedPath: sensitivePath,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('sensitive-path');
    }
  });

  it('allows similar but non-sensitive user directories', async () => {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'];
    if (!home) {
      return;
    }

    // Should allow ~/.ssh_backup as it's not strictly ~/.ssh/ or ~/.ssh
    const similarPath = path.join(home, '.ssh_backup');
    const result = await resolveValidatedPath({
      requestedPath: similarPath,
    });

    // It might still fail if the path doesn't exist and allowMissing=false (default is true),
    // but it should NOT be 'sensitive-path'
    if (!result.ok) {
      expect(result.error.code).not.toBe('sensitive-path');
    } else {
      expect(result.ok).toBe(true);
    }
  });

  it('allows sensitive unix paths on win32 platform override', async () => {
    const result = await resolveValidatedPath({
      requestedPath: '/etc/passwd',
      platform: 'win32',
    });

    // Should not reject as sensitive-path when platform is win32
    expect(result.ok).toBe(true);
  });

  it('resolves absolute paths without rootDir', async () => {
    const result = await resolveValidatedPath({
      requestedPath: tempDir,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Without rootDir, the function returns a resolved path (may differ from realpath on macOS)
      expect(result.path).toContain('path-validate-');
      expect(path.isAbsolute(result.path)).toBe(true);
    }
  });

  it('handles empty rootDir gracefully', async () => {
    const result = await resolveValidatedPath({
      rootDir: '',
      requestedPath: tempDir,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // With empty rootDir, returns resolved path without realpath resolution
      expect(result.path).toContain('path-validate-');
      expect(path.isAbsolute(result.path)).toBe(true);
    }
  });

  it('rejects missing paths when allowMissing is false', async () => {
    const result = await resolveValidatedPath({
      rootDir: tempDir,
      requestedPath: 'nonexistent-file.txt',
      allowMissing: false,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('realpath-failure');
    }
  });
});

describe('expandHome', () => {
  it('expands tilde paths using HOME env var', () => {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'];
    if (!home) {
      return;
    }
    const expanded = expandHome('~/Documents');
    expect(expanded).toBe(path.join(home, 'Documents'));
  });

  it('returns path unchanged when not starting with ~/', () => {
    expect(expandHome('/absolute/path')).toBe('/absolute/path');
    expect(expandHome('relative/path')).toBe('relative/path');
    expect(expandHome('~notahome')).toBe('~notahome');
  });

  it('returns original path when HOME and USERPROFILE are undefined', () => {
    const originalHome = process.env['HOME'];
    const originalUserProfile = process.env['USERPROFILE'];

    vi.stubEnv('HOME', undefined as unknown as string);
    vi.stubEnv('USERPROFILE', undefined as unknown as string);

    try {
      const result = expandHome('~/test');
      expect(result).toBe('~/test');
    } finally {
      if (originalHome !== undefined) {
        process.env['HOME'] = originalHome;
      }
      if (originalUserProfile !== undefined) {
        process.env['USERPROFILE'] = originalUserProfile;
      }
      vi.unstubAllEnvs();
    }
  });
});

describe('normalizeRootDir', () => {
  it('resolves relative paths to absolute', () => {
    const normalized = normalizeRootDir('.');
    expect(path.isAbsolute(normalized)).toBe(true);
  });

  it('expands home directory in root paths', () => {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'];
    if (!home) {
      return;
    }
    const normalized = normalizeRootDir('~/projects');
    expect(normalized).toBe(path.resolve(path.join(home, 'projects')));
  });
});

describe('isPathInsideRoot', () => {
  it('correctly identifies paths inside root', () => {
    expect(isPathInsideRoot('/home/user', '/home/user/docs')).toBe(true);
    expect(isPathInsideRoot('/home/user', '/home/user')).toBe(true);
    expect(isPathInsideRoot('/home/user', '/home/user/a/b/c')).toBe(true);
  });

  it('rejects paths outside root', () => {
    expect(isPathInsideRoot('/home/user', '/home/other')).toBe(false);
    expect(isPathInsideRoot('/home/user', '/etc/passwd')).toBe(false);
    expect(isPathInsideRoot('/home/user', '/home/user/../other')).toBe(false);
  });
});
