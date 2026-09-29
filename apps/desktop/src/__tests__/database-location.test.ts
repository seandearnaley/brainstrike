import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createWorktreeScopedProfile,
  type DatabaseLocationInput,
  PACKAGED_PRODUCT_DIR_NAME,
  resolveDatabaseLocation,
  sanitizeProfileSegment,
} from '../database-location';

const PRODUCT = 'BrainStrike Desktop';
const GIT = { branch: 'feature/awesome', workspaceSeed: '/repo/worktrees/wt-a' } as const;

function input(overrides: Partial<DatabaseLocationInput> = {}): DatabaseLocationInput {
  return {
    env: {},
    isPackaged: false,
    isTestRun: false,
    paths: { documents: '/Users/me/Documents', home: '/Users/me', userData: '/Users/me/userData' },
    platform: 'darwin',
    productDirName: PRODUCT,
    readGitContext: () => null,
    ...overrides,
  };
}

describe('resolveDatabaseLocation', () => {
  it.each([
    {
      expected: {
        profile: 'default',
        rootPath: '/Users/me/Library/Application Support/BrainStrike Desktop/data',
        source: 'packaged',
      },
      name: 'packaged macOS (no NODE_ENV involved) keeps data inside userData/data',
      overrides: {
        isPackaged: true,
        paths: {
          documents: '/Users/me/Documents',
          home: '/Users/me',
          userData: '/Users/me/Library/Application Support/BrainStrike Desktop',
        },
        platform: 'darwin',
      },
    },
    {
      expected: {
        profile: 'default',
        rootPath: 'C:\\Users\\me\\AppData\\Local\\BrainStrike Desktop\\data',
        source: 'packaged',
      },
      name: 'packaged Windows uses the non-roaming LOCALAPPDATA',
      overrides: {
        env: { localAppData: 'C:\\Users\\me\\AppData\\Local' },
        isPackaged: true,
        paths: {
          documents: 'C:\\Users\\me\\Documents',
          home: 'C:\\Users\\me',
          userData: 'C:\\Users\\me\\AppData\\Roaming\\BrainStrike Desktop',
        },
        platform: 'win32',
      },
    },
    {
      expected: {
        profile: 'default',
        rootPath: '/xdg/data/BrainStrike Desktop/data',
        source: 'packaged',
      },
      name: 'packaged Linux honours an absolute XDG_DATA_HOME',
      overrides: { env: { xdgDataHome: '/xdg/data' }, isPackaged: true, platform: 'linux' },
    },
    {
      expected: {
        profile: 'default',
        rootPath: '/home/me/.local/share/BrainStrike Desktop/data',
        source: 'packaged',
      },
      name: 'packaged Linux without XDG_DATA_HOME uses ~/.local/share',
      overrides: {
        isPackaged: true,
        paths: {
          documents: '/home/me/Documents',
          home: '/home/me',
          userData: '/home/me/.config/x',
        },
        platform: 'linux',
      },
    },
    {
      expected: {
        profile: 'default',
        rootPath: '/home/me/.local/share/BrainStrike Desktop/data',
        source: 'packaged',
      },
      name: 'packaged Linux treats an empty XDG_DATA_HOME as unset (XDG spec)',
      overrides: {
        env: { xdgDataHome: '' },
        isPackaged: true,
        paths: {
          documents: '/home/me/Documents',
          home: '/home/me',
          userData: '/home/me/.config/x',
        },
        platform: 'linux',
      },
    },
    {
      expected: {
        profile: 'default',
        rootPath: '/home/me/.local/share/BrainStrike Desktop/data',
        source: 'packaged',
      },
      name: 'packaged Linux ignores a relative XDG_DATA_HOME (XDG spec: invalid, ignored)',
      overrides: {
        env: { xdgDataHome: 'relative/share' },
        isPackaged: true,
        paths: {
          documents: '/home/me/Documents',
          home: '/home/me',
          userData: '/home/me/.config/x',
        },
        platform: 'linux',
      },
    },
    {
      expected: {
        profile: 'branch-feature-awesome-wt-',
        rootPath: '/Users/me/Documents/BrainStrike-dev',
        source: 'development',
      },
      name: 'development keeps Documents/BrainStrike-dev with a branch-scoped profile',
      overrides: { readGitContext: () => GIT },
    },
    {
      expected: {
        profile: 'dev-default',
        rootPath: '/Users/me/Documents/BrainStrike-dev',
        source: 'development',
      },
      name: 'development without git metadata uses dev-default',
      overrides: {},
    },
    {
      expected: {
        profile: 'dev-default',
        rootPath: '/Users/me/Documents/BrainStrike-dev',
        source: 'development',
      },
      name: 'development on a detached checkout with no branch uses dev-default',
      overrides: { readGitContext: () => ({ branch: null, workspaceSeed: '/repo' }) },
    },
    {
      expected: { profile: 'test', rootPath: '/Users/me/userData', source: 'test' },
      name: 'a test run isolates into userData with the test profile',
      overrides: { isTestRun: true },
    },
    {
      expected: { profile: 'test', rootPath: '/Users/me/userData', source: 'test' },
      name: 'a packaged test run (the CI smoke) is still a test run',
      overrides: { isPackaged: true, isTestRun: true, platform: 'linux' },
    },
  ] as const)('$name', ({ expected, overrides }) => {
    const location = resolveDatabaseLocation(input(overrides as Partial<DatabaseLocationInput>));

    expect(location.rootPath).toBe(expected.rootPath);
    expect(location.source).toBe(expected.source);
    if (expected.profile.endsWith('-wt-')) {
      expect(location.profile).toMatch(/^branch-feature-awesome-wt-[a-f0-9]{8}$/u);
      return;
    }
    expect(location.profile).toBe(expected.profile);
  });

  it('throws instead of falling back when a packaged Windows build has no LOCALAPPDATA', () => {
    expect(() => resolveDatabaseLocation(input({ isPackaged: true, platform: 'win32' }))).toThrow(
      /LOCALAPPDATA/u
    );
    expect(() =>
      resolveDatabaseLocation(
        input({ env: { localAppData: 'relative\\dir' }, isPackaged: true, platform: 'win32' })
      )
    ).toThrow(/LOCALAPPDATA/u);
  });

  it('throws for a packaged platform Electron does not ship on', () => {
    expect(() => resolveDatabaseLocation(input({ isPackaged: true, platform: 'freebsd' }))).toThrow(
      /freebsd/u
    );
  });

  it('lets an explicit root override win over every default, including a missing LOCALAPPDATA', () => {
    const location = resolveDatabaseLocation(
      input({ env: { rootOverride: 'D:\\db-root' }, isPackaged: true, platform: 'win32' })
    );

    expect(location.rootPath).toBe('D:\\db-root');
    expect(location.profile).toBe('default');
    expect(location.source).toBe('packaged');
  });

  it('lets an explicit profile override win, sanitised, over the derived profile', () => {
    const fromGit = resolveDatabaseLocation(
      input({ env: { profileOverride: ' Feature/X y ' }, readGitContext: () => GIT })
    );
    const inTestRun = resolveDatabaseLocation(
      input({ env: { profileOverride: 'mine' }, isTestRun: true })
    );

    expect(fromGit.profile).toBe('feature-x-y');
    expect(fromGit.rootPath).toBe('/Users/me/Documents/BrainStrike-dev');
    expect(inTestRun.profile).toBe('mine');
    expect(inTestRun.rootPath).toBe('/Users/me/userData');
  });

  it.each([
    ['.hidden', 'hidden'],
    ['a/b', 'a-b'],
    ['a\\b', 'a-b'],
    ['foo.', 'foo'],
  ])('maps the explicit profile override %j to the safe segment %j', (raw, expected) => {
    expect(resolveDatabaseLocation(input({ env: { profileOverride: raw } })).profile).toBe(
      expected
    );
  });

  it.each(['.', '..', '...', '  ..  ', './.', '../..', '/', '\\', '***', '-'])(
    'throws for the explicit profile override %j instead of guessing a profile',
    (raw) => {
      expect(() => resolveDatabaseLocation(input({ env: { profileOverride: raw } }))).toThrow(
        /BRAINSTRIKE_DB_PROFILE/u
      );
    }
  );

  it.each([{ isPackaged: true, platform: 'linux' }, { isTestRun: true }, {}] as const)(
    'rejects an unusable profile override in every mode (%j) and beside a root override',
    (mode) => {
      const withProfile = { profileOverride: '..' };

      expect(() =>
        resolveDatabaseLocation(
          input({ ...(mode as Partial<DatabaseLocationInput>), env: withProfile })
        )
      ).toThrow(/BRAINSTRIKE_DB_PROFILE/u);
      expect(() =>
        resolveDatabaseLocation(
          input({
            ...(mode as Partial<DatabaseLocationInput>),
            env: { ...withProfile, rootOverride: '/r' },
          })
        )
      ).toThrow(/BRAINSTRIKE_DB_PROFILE/u);
    }
  );

  it('reports source override only when the environment supplied both fields', () => {
    expect(
      resolveDatabaseLocation(input({ env: { profileOverride: 'p', rootOverride: '/r' } }))
    ).toEqual({ profile: 'p', rootPath: '/r', source: 'override' });
    expect(resolveDatabaseLocation(input({ env: { rootOverride: '/r' } })).source).toBe(
      'development'
    );
  });

  it.each(['undefined', 'UNDEFINED', '  undefined ', '', '   '])(
    'ignores the leaked literal or blank override %j',
    (leaked) => {
      const location = resolveDatabaseLocation(
        input({ env: { profileOverride: leaked, rootOverride: leaked }, isTestRun: true })
      );

      expect(location).toEqual({ profile: 'test', rootPath: '/Users/me/userData', source: 'test' });
    }
  );

  it('does not read git metadata unless the development profile needs it', () => {
    const readGitContext = vi.fn(() => GIT);

    resolveDatabaseLocation(input({ isPackaged: true, readGitContext }));
    resolveDatabaseLocation(input({ isTestRun: true, readGitContext }));
    resolveDatabaseLocation(input({ env: { profileOverride: 'p' }, readGitContext }));

    expect(readGitContext).not.toHaveBeenCalled();
  });

  it('joins with the injected platform separators regardless of the host OS', () => {
    const location = resolveDatabaseLocation(
      input({
        env: { localAppData: 'C:\\L' },
        isPackaged: true,
        platform: 'win32',
        productDirName: 'P',
      })
    );

    expect(location.rootPath).toBe('C:\\L\\P\\data');
  });
});

describe('profile helpers', () => {
  it.each([
    ['  Feature/Branch_1 ', 'feature-branch_1'],
    ['a/b', 'a-b'],
    ['a\\b', 'a-b'],
    ['../x', 'x'],
    ['.hidden', 'hidden'],
    ['..hidden', 'hidden'],
    ['foo.', 'foo'],
    ['a..b', 'a..b'],
    ['v1.2', 'v1.2'],
    [`${'a'.repeat(63)}.b`, 'a'.repeat(63)],
    ['.', 'default'],
    ['..', 'default'],
    ['...', 'default'],
    ['./.', 'default'],
    ['', 'default'],
    ['   ', 'default'],
    ['***', 'default'],
  ])('sanitises %j to the single safe segment %j', (raw, expected) => {
    expect(sanitizeProfileSegment(raw)).toBe(expected);
  });

  it('never returns anything but a one-segment, non-dot-leading name of at most 64 characters', () => {
    const hostile = [
      '.',
      '..',
      '...',
      '.hidden',
      'a/b',
      'a\\b',
      '../..',
      '..\\..',
      '/',
      '\\',
      'x'.repeat(200),
    ];
    for (const raw of hostile) {
      const segment = sanitizeProfileSegment(raw);

      expect(segment).toMatch(/^[a-z0-9_][a-z0-9._-]{0,63}$/u);
      expect(segment).not.toMatch(/\.$/u);
      expect(path.posix.basename(segment)).toBe(segment);
      expect(path.win32.basename(segment)).toBe(segment);
    }
  });

  it('keeps a dot-only branch inside a composite name, never as a bare path segment', () => {
    expect(createWorktreeScopedProfile('..', '/repo')).toMatch(/^branch-default-wt-[a-f0-9]{8}$/u);
  });

  it('scopes a worktree profile by branch and a stable hash of the workspace seed', () => {
    const first = createWorktreeScopedProfile('main', '/repo/a');

    expect(first).toMatch(/^branch-main-wt-[a-f0-9]{8}$/u);
    expect(createWorktreeScopedProfile('main', '/repo/a')).toBe(first);
    expect(createWorktreeScopedProfile('main', '/repo/b')).not.toBe(first);
  });
});

describe('PACKAGED_PRODUCT_DIR_NAME', () => {
  it('is the electron-builder productName, so the OS data folder carries the shipped app name', () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')
    ) as { build: { productName: string } };

    expect(PACKAGED_PRODUCT_DIR_NAME).toBe(packageJson.build.productName);
  });
});
