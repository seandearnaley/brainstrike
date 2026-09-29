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
} from '../path-validation.js';

const home = process.env['HOME'] ?? process.env['USERPROFILE'];
const isWin32 = process.platform === 'win32';

describe('resolveValidatedPath', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-validate-'));
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { force: true, recursive: true });
  });

  it('resolves paths inside the configured root', async () => {
    const result = await resolveValidatedPath({
      requestedPath: '.',
      rootDir: tempDir,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(await fsPromises.realpath(tempDir));
    }
  });

  it('rejects null bytes', async () => {
    const result = await resolveValidatedPath({
      requestedPath: '/tmp/\0oops',
      rootDir: tempDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('null-byte');
    }
  });

  it('uses the fallback when the requested path is empty', async () => {
    const result = await resolveValidatedPath({
      fallbackPath: 'fallback-folder',
      requestedPath: '',
      rootDir: tempDir,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const rootReal = await fsPromises.realpath(tempDir);
      expect(result.path).toBe(path.join(rootReal, 'fallback-folder'));
    }
  });

  it('rejects when requested and fallback are blank', async () => {
    const result = await resolveValidatedPath({
      fallbackPath: ' ',
      requestedPath: '   ',
      rootDir: tempDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-input');
    }
  });

  it('rejects excessive traversal', async () => {
    const traversal = '../'.repeat(DEFAULT_TRAVERSAL_LIMIT + 1);
    const result = await resolveValidatedPath({
      requestedPath: traversal,
      rootDir: tempDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('traversal');
    }
  });

  it('accepts a directory whose name contains ".." substrings at maxTraversal 0', async () => {
    // Real-world shape: nyc coverage-input dirs flatten relative paths with
    // "__" separators, e.g. "..__..__..__var__folders__T__packages__db".
    const nycStyleName = '..__..__..__..__..__var__folders__T__packages__db';
    const dirPath = path.join(tempDir, nycStyleName);
    await fsPromises.mkdir(dirPath);

    const result = await resolveValidatedPath({
      allowMissing: false,
      maxTraversal: 0,
      requestedPath: dirPath,
      rootDir: tempDir,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(path.join(await fsPromises.realpath(tempDir), nycStyleName));
    }
  });

  it('accepts a filename containing a git range ".." at maxTraversal 0', async () => {
    const filePath = path.join(tempDir, 'review-3f61bcd58..2180072ee.diff');
    await fsPromises.writeFile(filePath, 'diff');

    const result = await resolveValidatedPath({
      allowMissing: false,
      maxTraversal: 0,
      requestedPath: filePath,
      rootDir: tempDir,
    });

    expect(result.ok).toBe(true);
  });

  it('rejects a real ".." segment at maxTraversal 0', async () => {
    const result = await resolveValidatedPath({
      maxTraversal: 0,
      requestedPath: '../sibling',
      rootDir: tempDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('traversal');
    }
  });

  it('rejects Win32 ".." aliases (trailing dots/spaces) at maxTraversal 0', async () => {
    // Win32 strips trailing dots and spaces per path component, so ".. " and
    // "..." open as "..". The lexical counter must treat them as traversal.
    for (const requestedPath of ['.. \\sibling', 'foo/.. /bar', '...\\sibling', '.. ']) {
      const result = await resolveValidatedPath({
        maxTraversal: 0,
        requestedPath,
        rootDir: tempDir,
      });

      expect(result.ok, `expected rejection for ${JSON.stringify(requestedPath)}`).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('traversal');
      }
    }
  });

  it('rejects a real backslash ".." segment at maxTraversal 0', async () => {
    // The separator split is platform-independent by design — no `platform`
    // option here; backslash segments are counted on POSIX too.
    const result = await resolveValidatedPath({
      maxTraversal: 0,
      requestedPath: '..\\sibling',
      rootDir: tempDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('traversal');
    }
  });

  it('rejects paths outside the root when missing', async () => {
    const result = await resolveValidatedPath({
      requestedPath: '../outside-root',
      rootDir: tempDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('outside-root');
    }
  });

  it('allows missing paths inside the root', async () => {
    const result = await resolveValidatedPath({
      requestedPath: 'missing-folder',
      rootDir: tempDir,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const rootReal = await fsPromises.realpath(tempDir);
      expect(result.path).toBe(path.join(rootReal, 'missing-folder'));
    }
  });

  it.skipIf(isWin32)('rejects sensitive directories on unix', async () => {
    const result = await resolveValidatedPath({
      requestedPath: '/etc/passwd',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('sensitive-path');
    }
  });

  it.skipIf(isWin32)('rejects sensitive procfs directories on unix', async () => {
    const result = await resolveValidatedPath({
      requestedPath: '/proc/self/cmdline',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('sensitive-path');
    }
  });

  it.skipIf(!home)('rejects sensitive user directories', async () => {
    const sensitivePath = path.join(home!, '.ssh', 'id_rsa');
    const result = await resolveValidatedPath({
      requestedPath: sensitivePath,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('sensitive-path');
    }
  });

  it.skipIf(!home)('rejects sensitive user directories (exact match)', async () => {
    const sensitivePath = path.join(home!, '.aws');
    const result = await resolveValidatedPath({
      requestedPath: sensitivePath,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('sensitive-path');
    }
  });

  it.skipIf(!home)('allows similar but non-sensitive user directories', async () => {
    const similarPath = path.join(home!, '.ssh_backup');
    const result = await resolveValidatedPath({
      requestedPath: similarPath,
    });

    // Should NOT be 'sensitive-path'
    if (result.ok) {
      expect(result.ok).toBe(true);
    } else {
      expect(result.error.code).not.toBe('sensitive-path');
    }
  });

  it.skipIf(!home)('rejects newly added sensitive user directories (.docker)', async () => {
    const sensitivePath = path.join(home!, '.docker', 'config.json');
    const result = await resolveValidatedPath({
      requestedPath: sensitivePath,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('sensitive-path');
    }
  });

  // BST-1386. `isSensitiveUserPath` deliberately fails open when neither HOME
  // nor USERPROFILE is set: a containerised or CI environment legitimately has
  // no home directory, and blocking every path would be worse than skipping
  // the user-directory check. Every other sensitive-user-directory test here is
  // `skipIf(!home)` and reads the real machine's HOME, so all of them cover the
  // home-PRESENT path; nothing exercised the absent branch, and mutating its
  // guard to `false` survived.
  //
  // Both halves are asserted, because only the pair pins the fail-open RULING.
  // The check anchors on `path.join(home, dir)`, so proving a tmpdir path is
  // allowed while HOME is unset would prove nothing on its own — that path is
  // allowed with HOME set too. Pointing HOME at tempDir first makes the same
  // candidate genuinely sensitive, so the second half is the branch and not
  // the input. It also proves the validator reads the env lazily at call time:
  // a module-scope capture would make the first half fail.
  //
  // Unguarded on win32, unlike its `skipIf(isWin32)` neighbours, because the
  // mixed combination is safe rather than untested: `platform: 'linux'` only
  // selects the case-sensitive comparison branch, and both the candidate and
  // the sensitive root are built from the same `tempDir` by `path.join`, so
  // they agree on separator and case on either OS. The unix system-directory
  // prefixes cannot match a drive-letter path.
  it('fails open on an otherwise-sensitive user path when HOME and USERPROFILE are absent', async () => {
    try {
      const candidate = path.join(tempDir, '.ssh', 'id_rsa');
      const options = {
        allowMissing: true,
        blockSensitiveDirectories: true,
        platform: 'linux' as NodeJS.Platform,
        requestedPath: candidate,
      };

      // HOME present, pointing at tempDir: this exact path IS rejected.
      vi.stubEnv('HOME', tempDir);
      vi.stubEnv('USERPROFILE', tempDir);
      const withHome = await resolveValidatedPath(options);
      expect(withHome.ok).toBe(false);
      if (!withHome.ok) {
        expect(withHome.error.code).toBe('sensitive-path');
      }

      // HOME absent: the same path is allowed, because the check is skipped.
      vi.stubEnv('HOME', undefined);
      vi.stubEnv('USERPROFILE', undefined);
      // Self-guarding: `vi.stubEnv(name, undefined)` DELETES the key. If that
      // ever regressed to assigning the string "undefined", the guard would
      // take its home-present branch, `path.join('undefined', '.ssh')` would
      // not throw, and the mutant this test kills would survive a green run.
      expect(process.env['HOME']).toBeUndefined();
      expect(process.env['USERPROFILE']).toBeUndefined();

      // `path.resolve`, not realpath: with no rootDir and allowMissing, the
      // validator returns the candidate before `fs.realpath` is reached, so
      // realpathing here would compare the wrong thing (macOS puts os.tmpdir()
      // under the /var -> /private/var symlink).
      expect(await resolveValidatedPath(options)).toEqual({
        ok: true,
        path: path.resolve(candidate),
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.skipIf(!home || isWin32)('rejects symlinks pointing to sensitive directories', async () => {
    const symlinkPath = path.join(tempDir, 'sneaky-link');
    const sshDir = path.join(home!, '.ssh');

    // Only run if ~/.ssh actually exists (most dev machines have it)
    try {
      await fsPromises.stat(sshDir);
    } catch {
      return;
    }

    await fsPromises.symlink(sshDir, symlinkPath);

    const result = await resolveValidatedPath({
      requestedPath: 'sneaky-link',
      rootDir: tempDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('sensitive-path');
    }
  });

  it('allows sensitive unix paths on win32 platform override', async () => {
    const result = await resolveValidatedPath({
      platform: 'win32',
      requestedPath: '/etc/passwd',
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
      expect(result.path).toContain('path-validate-');
      expect(path.isAbsolute(result.path)).toBe(true);
    }
  });

  it('handles empty rootDir gracefully', async () => {
    const result = await resolveValidatedPath({
      requestedPath: tempDir,
      rootDir: '',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toContain('path-validate-');
      expect(path.isAbsolute(result.path)).toBe(true);
    }
  });

  it('rejects missing paths when allowMissing is false', async () => {
    const result = await resolveValidatedPath({
      allowMissing: false,
      requestedPath: 'nonexistent-file.txt',
      rootDir: tempDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('realpath-failure');
    }
  });

  it('allows sensitive paths when blocking is disabled', async () => {
    const result = await resolveValidatedPath({
      blockSensitiveDirectories: false,
      platform: 'linux',
      requestedPath: '/etc/passwd',
    });

    expect(result.ok).toBe(true);
  });

  it('rejects symlinks that resolve outside the configured root', async () => {
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-validate-external-'));
    const outsideFile = path.join(externalDir, 'outside.txt');
    const linkPath = path.join(tempDir, 'outside-link.txt');

    try {
      fs.writeFileSync(outsideFile, 'outside');
      await fsPromises.symlink(outsideFile, linkPath);

      const result = await resolveValidatedPath({
        requestedPath: 'outside-link.txt',
        rootDir: tempDir,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('outside-root');
        expect(result.error.path).toBe(await fsPromises.realpath(outsideFile));
      }
    } finally {
      await fsPromises.rm(externalDir, { force: true, recursive: true });
    }
  });

  it('rejects fallbackPath containing null bytes when requestedPath is empty', async () => {
    const result = await resolveValidatedPath({
      fallbackPath: 'some\0path',
      requestedPath: '',
      rootDir: tempDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('null-byte');
    }
  });

  it('rejects fallbackPath with excessive traversal when requestedPath is null', async () => {
    const traversal = '../'.repeat(DEFAULT_TRAVERSAL_LIMIT + 1);
    const result = await resolveValidatedPath({
      fallbackPath: traversal,
      requestedPath: null,
      rootDir: tempDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('traversal');
    }
  });

  it('rejects with outside-root when allowMissing is false and path is outside root', async () => {
    const result = await resolveValidatedPath({
      allowMissing: false,
      requestedPath: '../nonexistent-outside',
      rootDir: tempDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('outside-root');
    }
  });

  it('rejects traversal with custom maxTraversal limit', async () => {
    const result = await resolveValidatedPath({
      maxTraversal: 2,
      requestedPath: '../../../deep',
      rootDir: tempDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('traversal');
    }
  });

  it.each([false, true])(
    'returns realpath-failure for non-ENOENT errors when allowMissing is %s',
    async (allowMissing) => {
      const spy = vi.spyOn(fsPromises, 'realpath');
      const candidate = path.join(tempDir, 'some-file.txt');
      const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      spy.mockImplementation(async (input: fs.PathLike) => {
        const resolved = input.toString();
        if (resolved === candidate) {
          throw eacces;
        }
        return resolved;
      });

      try {
        const result = await resolveValidatedPath({
          allowMissing,
          requestedPath: 'some-file.txt',
          rootDir: tempDir,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('realpath-failure');
          expect(result.error.message).toBe('permission denied');
        }
      } finally {
        spy.mockRestore();
      }
    }
  );

  it.skipIf(!home)(
    'blocks sensitive user directory with win32 platform (case-insensitive)',
    async () => {
      const mixedCasePath = path.join(home!, '.SSH', 'id_rsa');
      const result = await resolveValidatedPath({
        platform: 'win32',
        requestedPath: mixedCasePath,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('sensitive-path');
      }
    }
  );

  it('resolves absolute non-existent path with no rootDir and allowMissing true', async () => {
    const nonExistentAbsolute = path.join(tempDir, 'deeply', 'nested', 'missing');
    const result = await resolveValidatedPath({
      allowMissing: true,
      requestedPath: nonExistentAbsolute,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(nonExistentAbsolute);
    }
  });

  it.skipIf(isWin32)(
    'does not dereference symlinks on the rootless allowMissing fast path',
    async () => {
      // This pins the lexical no-realpath branch only. Trusted I/O callers must
      // still bind paths to canonical roots before opening symlink targets (BST-1237).
      const targetPath = path.join(tempDir, 'target');
      const symlinkPath = path.join(tempDir, 'link');
      await fsPromises.mkdir(targetPath);
      await fsPromises.symlink(targetPath, symlinkPath);

      const result = await resolveValidatedPath({
        allowMissing: true,
        requestedPath: symlinkPath,
      });

      expect(result).toEqual({ ok: true, path: symlinkPath });
    }
  );

  it('falls back to fallbackPath when requestedPath is a non-string type', async () => {
    // number
    const resultNum = await resolveValidatedPath({
      fallbackPath: 'fallback-folder',
      requestedPath: 42 as unknown,
      rootDir: tempDir,
    });
    expect(resultNum.ok).toBe(true);
    if (resultNum.ok) {
      const rootReal = await fsPromises.realpath(tempDir);
      expect(resultNum.path).toBe(path.join(rootReal, 'fallback-folder'));
    }

    // null
    const resultNull = await resolveValidatedPath({
      fallbackPath: 'fallback-folder',
      requestedPath: null as unknown,
      rootDir: tempDir,
    });
    expect(resultNull.ok).toBe(true);
    if (resultNull.ok) {
      const rootReal = await fsPromises.realpath(tempDir);
      expect(resultNull.path).toBe(path.join(rootReal, 'fallback-folder'));
    }

    // undefined with no fallback => invalid-input
    const resultUndef = await resolveValidatedPath({
      requestedPath: undefined as unknown,
      rootDir: tempDir,
    });
    expect(resultUndef.ok).toBe(false);
    if (!resultUndef.ok) {
      expect(resultUndef.error.code).toBe('invalid-input');
    }
  });
});

describe('expandHome', () => {
  it.skipIf(!home)('expands tilde paths using HOME env var', () => {
    const expanded = expandHome('~/Documents');
    expect(expanded).toBe(path.join(home!, 'Documents'));
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

  it.skipIf(!home)('expands home directory in root paths', () => {
    const normalized = normalizeRootDir('~/projects');
    expect(normalized).toBe(path.resolve(path.join(home!, 'projects')));
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

  it('rejects absolute paths on a different drive/root', () => {
    expect(isPathInsideRoot('/workspace/root', '/another/root/file.ts')).toBe(false);
  });

  it('accepts in-root children whose names start with ".."', () => {
    expect(isPathInsideRoot('/home/user', '/home/user/..__..__var__folders')).toBe(true);
    expect(isPathInsideRoot('/home/user', '/home/user/..hidden/file.ts')).toBe(true);
  });

  it('rejects the root parent itself', () => {
    expect(isPathInsideRoot('/home/user', '/home')).toBe(false);
  });
});
