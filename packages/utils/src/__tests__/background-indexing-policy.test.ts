import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_INDEXING_POLICY_OPTIONS,
  createBackgroundIndexingEntryPolicy,
  DEFAULT_BACKGROUND_INDEXING_MAX_FILE_SIZE,
  FULL_ROOT_SAFETY_EXCLUDED_DIRECTORY_SEGMENT_NAMES,
  isUnconditionalExcludedNativePath,
  UNCONDITIONAL_EXCLUDED_DIRECTORY_PATH_PREFIXES,
  UNCONDITIONAL_EXCLUDED_PATH_IGNORE_GLOBS,
} from '../background-indexing-policy.js';

describe('background-indexing-policy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // BST-1342/BST-1390: the watcher must drop managed-worktree events with the SAME
  // exclusion the index policy already applies — but watcher event paths are
  // NATIVE (absolute, either separator), unlike the root-relative
  // `/`-separated contract of isExcludedBackgroundIndexingPath.
  describe('isUnconditionalExcludedNativePath (BST-1342)', () => {
    it('matches the excluded tree at any depth with posix separators', () => {
      expect(
        isUnconditionalExcludedNativePath('/Users/x/repo/.claude/worktrees/agent-1/src/a.ts')
      ).toBe(true);
      expect(isUnconditionalExcludedNativePath('/repo/.claude/worktrees')).toBe(true);
      expect(isUnconditionalExcludedNativePath('.claude/worktrees/file')).toBe(true);
      expect(isUnconditionalExcludedNativePath('/repo/.brainstrike/worktrees/app/a.ts')).toBe(true);
    });

    it('matches windows separators and mixed case', () => {
      expect(isUnconditionalExcludedNativePath('C:\\repo\\.claude\\worktrees\\agent-1\\a.ts')).toBe(
        true
      );
      expect(isUnconditionalExcludedNativePath('C:\\repo\\.CLAUDE\\Worktrees\\a.ts')).toBe(true);
    });

    it('stays segment-anchored: near-miss names never match', () => {
      expect(isUnconditionalExcludedNativePath('/repo/.claude/worktrees-backup/a.ts')).toBe(false);
      expect(isUnconditionalExcludedNativePath('/repo/x.claude/worktrees/a.ts')).toBe(false);
      expect(isUnconditionalExcludedNativePath('/repo/.claude/other/worktrees/a.ts')).toBe(false);
      expect(isUnconditionalExcludedNativePath('/repo/src/index.ts')).toBe(false);
    });
  });

  describe('UNCONDITIONAL_EXCLUDED_PATH_IGNORE_GLOBS (BST-1342)', () => {
    it('exposes the excluded trees as native-watcher ignore globs', () => {
      expect(UNCONDITIONAL_EXCLUDED_PATH_IGNORE_GLOBS).toEqual([
        '**/.claude/worktrees',
        '**/.claude/worktrees/**',
        '**/.brainstrike/worktrees',
        '**/.brainstrike/worktrees/**',
        '**/.muse/worktrees',
        '**/.muse/worktrees/**',
      ]);
    });
  });

  it.each(['balanced', 'full-root'] as const)(
    '%s excludes nested Muse worktree copies without excluding ordinary Muse content',
    (preset) => {
      const policy = createBackgroundIndexingEntryPolicy({ preset });
      expect(
        policy.shouldTraverseDirectory({
          directoryName: 'worktrees',
          relativePath: '.muse/worktrees',
        })
      ).toBe(false);
      expect(
        policy.shouldIncludeFile({
          fileName: 'index.ts',
          fileSize: 128,
          relativePath: '.muse/worktrees/old/src/index.ts',
        })
      ).toBe(false);
      for (const relativePath of [
        '.muse/settings.md',
        '.muse/worktrees-backup/index.ts',
        'src/index.ts',
      ]) {
        expect(
          policy.shouldIncludeFile({
            fileName: relativePath.split('/').at(-1) ?? '',
            fileSize: 128,
            relativePath,
          })
        ).toBe(true);
      }
      expect(isUnconditionalExcludedNativePath('/repo/.muse/worktrees/old/src/index.ts')).toBe(
        true
      );
      expect(
        isUnconditionalExcludedNativePath('C:\\repo\\.MUSE\\worktrees\\old\\src\\index.ts')
      ).toBe(true);
      expect(isUnconditionalExcludedNativePath('/repo/.muse/worktrees-backup/index.ts')).toBe(
        false
      );
    }
  );

  it('keeps BrainStrike managed worktrees in the unconditional exclusion floor', () => {
    expect(UNCONDITIONAL_EXCLUDED_DIRECTORY_PATH_PREFIXES).toContain('.brainstrike/worktrees');
  });

  it('defaults to the balanced preset metadata', () => {
    expect(BACKGROUND_INDEXING_POLICY_OPTIONS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Balanced',
          recommended: true,
          value: 'balanced',
        }),
        expect.objectContaining({
          label: 'Full root',
          recommended: false,
          value: 'full-root',
        }),
      ])
    );
  });

  it('balanced policy indexes source and docs but skips generated artifacts', () => {
    const policy = createBackgroundIndexingEntryPolicy({ preset: 'balanced' });

    expect(
      policy.shouldIncludeFile({
        fileName: 'index.ts',
        fileSize: 128,
        relativePath: 'src/index.ts',
      })
    ).toBe(true);
    expect(
      policy.shouldIncludeFile({
        fileName: 'README.md',
        fileSize: 512,
        relativePath: 'README.md',
      })
    ).toBe(true);
    expect(
      policy.shouldIncludeFile({
        fileName: 'Dockerfile',
        fileSize: 64,
        relativePath: 'Dockerfile',
      })
    ).toBe(true);

    expect(
      policy.shouldIncludeFile({
        fileName: 'app.min.js',
        fileSize: 512,
        relativePath: 'public/assets/app.min.js',
      })
    ).toBe(false);
    expect(
      policy.shouldIncludeFile({
        fileName: 'pnpm-lock.yaml',
        fileSize: 2048,
        relativePath: 'pnpm-lock.yaml',
      })
    ).toBe(false);
    expect(
      policy.shouldTraverseDirectory({
        directoryName: 'coverage',
        relativePath: 'coverage',
      })
    ).toBe(false);
    expect(
      policy.shouldTraverseDirectory({
        directoryName: 'worktrees',
        relativePath: '.brainstrike/worktrees',
      })
    ).toBe(false);
    expect(
      policy.shouldTraverseDirectory({
        directoryName: '.turbo',
        relativePath: '.turbo',
      })
    ).toBe(false);
    expect(
      policy.shouldTraverseDirectory({
        directoryName: 'node_modules',
        relativePath: 'node_modules',
      })
    ).toBe(false);
    expect(
      policy.shouldTraverseDirectory({
        directoryName: '.git',
        relativePath: '.git',
      })
    ).toBe(false);
    // `.claude/worktrees` holds throwaway git worktree copies of the whole
    // repo — duplicate snapshots that bloat the index and pollute semantic
    // search with near-identical hits — so both presets now skip it.
    expect(
      policy.shouldTraverseDirectory({
        directoryName: 'worktrees',
        relativePath: '.claude/worktrees',
      })
    ).toBe(false);
    expect(
      policy.shouldTraverseDirectory({
        directoryName: 'dual-state-refactor',
        relativePath: '.claude/worktrees/dual-state-refactor',
      })
    ).toBe(false);
    expect(
      policy.shouldTraverseDirectory({
        directoryName: 'dist',
        relativePath: 'dist',
      })
    ).toBe(false);
    expect(
      policy.shouldTraverseDirectory({
        directoryName: '.next',
        relativePath: '.next',
      })
    ).toBe(false);
  });

  it('checks balanced directory segments without splitting each traversed path', () => {
    const policy = createBackgroundIndexingEntryPolicy({ preset: 'balanced' });

    expect(
      policy.shouldTraverseDirectory({
        directoryName: 'icons',
        relativePath: 'src/features/icons',
      })
    ).toBe(true);

    const splitSpy = vi.spyOn(String.prototype, 'split');
    const shouldTraverseExcludedDirectory = policy.shouldTraverseDirectory({
      directoryName: 'node_modules',
      relativePath: 'src/vendor/node_modules',
    });

    expect(shouldTraverseExcludedDirectory).toBe(false);
    expect(splitSpy).not.toHaveBeenCalled();
  });

  it('excludes nyc coverage output directories under both presets', () => {
    // BST-1257: .nyc_output holds coverage artifacts (including path-mangled
    // dir names like "..__..__var" that triggered BST-1255) — never index it.
    for (const preset of ['balanced', 'full-root'] as const) {
      const policy = createBackgroundIndexingEntryPolicy({ preset });

      expect(
        policy.shouldTraverseDirectory({
          directoryName: '.nyc_output',
          relativePath: '.nyc_output',
        })
      ).toBe(false);
    }
  });

  it('balanced policy excludes Python environment and bytecode-cache directories', () => {
    const policy = createBackgroundIndexingEntryPolicy({ preset: 'balanced' });

    for (const relativePath of [
      '.venv',
      'venv',
      '__pycache__',
      'services/api/.venv/lib/python3.13/site-packages',
      'packages/jobs/venv/lib/python3.13/site-packages',
      'src/__pycache__',
    ]) {
      expect(
        policy.shouldTraverseDirectory({
          directoryName: relativePath.split('/').at(-1) ?? relativePath,
          relativePath,
        })
      ).toBe(false);
    }
  });

  it('balanced policy preserves ordinary source directories named env', () => {
    const policy = createBackgroundIndexingEntryPolicy({ preset: 'balanced' });

    expect(policy.shouldTraverseDirectory({ directoryName: 'env', relativePath: 'src/env' })).toBe(
      true
    );
    expect(
      policy.shouldIncludeFile({
        fileName: 'config.ts',
        fileSize: 128,
        relativePath: 'src/env/config.ts',
      })
    ).toBe(true);
  });

  it('full-root policy remains the explicit override for Python environments', () => {
    const policy = createBackgroundIndexingEntryPolicy({ preset: 'full-root' });

    for (const relativePath of ['.venv', 'venv', '__pycache__']) {
      expect(
        policy.shouldTraverseDirectory({
          directoryName: relativePath,
          relativePath,
        })
      ).toBe(true);
    }

    expect(policy.description).toContain('Python virtual environments');
  });

  it('full-root policy keeps non-binary text artifacts that balanced skips', () => {
    const policy = createBackgroundIndexingEntryPolicy({ preset: 'full-root' });

    expect(
      policy.shouldIncludeFile({
        fileName: 'pnpm-lock.yaml',
        fileSize: 2048,
        relativePath: 'pnpm-lock.yaml',
      })
    ).toBe(true);
    expect(
      policy.shouldIncludeFile({
        fileName: 'app.min.js',
        fileSize: 512,
        relativePath: 'public/assets/app.min.js',
      })
    ).toBe(true);
  });

  it('full-root policy still skips hard generated and cache directories', () => {
    const policy = createBackgroundIndexingEntryPolicy({ preset: 'full-root' });

    for (const relativePath of [
      '.git',
      '.turbo',
      '.turbo/cache',
      'node_modules',
      '.pnpm-store',
      '.next',
      'dist',
      'build',
      'coverage',
      'test-results',
    ]) {
      expect(
        policy.shouldTraverseDirectory({
          directoryName: relativePath.split('/').at(-1) ?? relativePath,
          relativePath,
        })
      ).toBe(false);
    }
  });

  it.each(['balanced', 'full-root'] as const)(
    '%s policy skips .claude/worktrees but keeps the rest of .claude',
    (preset) => {
      const policy = createBackgroundIndexingEntryPolicy({ preset });

      // The worktree copies themselves are excluded, directory and file alike.
      expect(
        policy.shouldTraverseDirectory({
          directoryName: 'worktrees',
          relativePath: '.claude/worktrees',
        })
      ).toBe(false);
      expect(
        policy.shouldTraverseDirectory({
          directoryName: 'nested',
          relativePath: '.claude/worktrees/feature-branch/packages/db/src',
        })
      ).toBe(false);
      expect(
        policy.shouldIncludeFile({
          fileName: 'index.ts',
          fileSize: 128,
          relativePath: '.claude/worktrees/feature-branch/src/index.ts',
        })
      ).toBe(false);

      // Exclusion is scoped to the worktrees subtree — the rest of .claude
      // (skills, commands, settings) and any unrelated top-level `worktrees`
      // directory are still traversed.
      expect(
        policy.shouldTraverseDirectory({
          directoryName: '.claude',
          relativePath: '.claude',
        })
      ).toBe(true);
      expect(
        policy.shouldTraverseDirectory({
          directoryName: 'skills',
          relativePath: '.claude/skills',
        })
      ).toBe(true);
      expect(
        policy.shouldTraverseDirectory({
          directoryName: 'worktrees',
          relativePath: 'packages/worktrees',
        })
      ).toBe(true);
    }
  );

  it('full-root policy skips macOS app and framework bundles', () => {
    const policy = createBackgroundIndexingEntryPolicy({ preset: 'full-root' });

    for (const relativePath of [
      'apps/desktop/release/mac-arm64/BrainStrike Desktop.app',
      'apps/desktop/release/mac-arm64/BrainStrike Desktop.app/Contents',
      'apps/desktop/release/mac-arm64/BrainStrike Desktop.app/Contents/Frameworks/Electron Framework.framework',
      'apps/desktop/release/mac-arm64/BrainStrike Desktop.app/Contents/Frameworks/Electron Framework.framework/Versions/Current',
    ]) {
      expect(
        policy.shouldTraverseDirectory({
          directoryName: relativePath.split('/').at(-1) ?? relativePath,
          relativePath,
        })
      ).toBe(false);
    }
  });

  it('skips binary and oversized files regardless of preset', () => {
    const policy = createBackgroundIndexingEntryPolicy({ preset: 'full-root' });

    expect(
      policy.shouldIncludeFile({
        fileName: 'logo.png',
        fileSize: 128,
        relativePath: 'assets/logo.png',
      })
    ).toBe(false);
    expect(
      policy.shouldIncludeFile({
        fileName: 'large.md',
        fileSize: DEFAULT_BACKGROUND_INDEXING_MAX_FILE_SIZE + 1,
        relativePath: 'docs/large.md',
      })
    ).toBe(false);
  });
});

describe('preset exclusion coherence', () => {
  // `full-root` is the MORE permissive preset — it deliberately indexes things
  // balanced skips (Python virtualenvs, generated output). So anything it still
  // excludes is there as a SAFETY exclusion, and balanced excluding less than
  // that is incoherent by construction.
  //
  // This is not hypothetical: `.pnpm-store` sat in the full-root safety list and
  // not in balanced. A pnpm content-addressable store inside a repo is ~82k
  // files, which is 1.6x the workspace walk's 50,000-file cap on its own — so
  // the walk exhausted its budget inside the store and never reached `apps/`,
  // `docs/` or `packages/`. Every workspace glob returned 0 matches for
  // patterns that plainly match, and the Explorer subagent burned its whole
  // step budget shelling out instead (BST-1410 field report, 2026-08-22).
  const balanced = createBackgroundIndexingEntryPolicy({ preset: 'balanced' });
  const fullRoot = createBackgroundIndexingEntryPolicy({ preset: 'full-root' });

  const traverses = (
    policy: ReturnType<typeof createBackgroundIndexingEntryPolicy>,
    name: string
  ): boolean => policy.shouldTraverseDirectory({ directoryName: name, relativePath: name });

  it('never traverses a directory in balanced that full-root excludes for safety', () => {
    const leakage = FULL_ROOT_SAFETY_EXCLUDED_DIRECTORY_SEGMENT_NAMES.filter(
      (name) => traverses(balanced, name) && !traverses(fullRoot, name)
    );
    expect(leakage).toEqual([]);
  });

  it('excludes the pnpm content-addressable store in BOTH presets', () => {
    // Named explicitly as well as covered by the invariant above: a store this
    // large silently blinds every workspace tool, and the failure looks like
    // "0 matches" rather than an error.
    expect(traverses(balanced, '.pnpm-store')).toBe(false);
    expect(traverses(fullRoot, '.pnpm-store')).toBe(false);
  });
});
