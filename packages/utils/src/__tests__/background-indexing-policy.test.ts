import { afterEach, vi } from 'vitest';
import {
  BACKGROUND_INDEXING_POLICY_OPTIONS,
  createBackgroundIndexingEntryPolicy,
  DEFAULT_BACKGROUND_INDEXING_MAX_FILE_SIZE,
} from '../background-indexing-policy';

describe('background-indexing-policy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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

  it.each([
    'balanced',
    'full-root',
  ] as const)('%s policy skips .claude/worktrees but keeps the rest of .claude', (preset) => {
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
  });

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
