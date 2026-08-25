import { getBaseFilename, isBinaryFile, isTextFile } from './file-utils.js';
import { createPathFilterMatcher } from './filter-utils.js';

export type BackgroundIndexingPolicyPreset = 'balanced' | 'full-root';

export interface BackgroundIndexingPolicyOption {
  description: string;
  label: string;
  recommended: boolean;
  value: BackgroundIndexingPolicyPreset;
}

export interface BackgroundIndexingDirectoryInput {
  directoryName: string;
  relativePath: string;
}

export interface BackgroundIndexingFileInput {
  fileName: string;
  fileSize: number | undefined;
  relativePath: string;
}

export interface BackgroundIndexingEntryPolicy {
  description: string;
  label: string;
  preset: BackgroundIndexingPolicyPreset;
  shouldIncludeFile: (input: BackgroundIndexingFileInput) => boolean;
  shouldTraverseDirectory: (input: BackgroundIndexingDirectoryInput) => boolean;
}

export interface BackgroundIndexingPolicyConfig {
  preset: BackgroundIndexingPolicyPreset;
}

export const DEFAULT_BACKGROUND_INDEXING_MAX_FILE_SIZE = 750 * 1024;

export const BACKGROUND_INDEXING_POLICY_OPTIONS: readonly BackgroundIndexingPolicyOption[] = [
  {
    description:
      'Indexes source, docs, and useful text files while skipping common dependency, generated, cache, lock, and minified artifacts.',
    label: 'Balanced',
    recommended: true,
    value: 'balanced',
  },
  {
    description:
      'Indexes broadly across the selected root, including Python virtual environments, while retaining hard safety limits like oversized files.',
    label: 'Full root',
    recommended: false,
    value: 'full-root',
  },
] as const;

const BALANCED_EXCLUDED_DIRECTORY_SEGMENTS = new Set([
  '.git',
  '.turbo',
  '.cache',
  '.nyc_output',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.vercel',
  '.parcel-cache',
  '.vite',
  // A repo-local pnpm content-addressable store. Present in the full-root
  // SAFETY list from the start but missing here, which is incoherent: full-root
  // is the more permissive preset. The gap blinded every workspace tool — a
  // store of ~82k files is 1.6x the workspace walk's 50,000-file cap on its own,
  // so the walk exhausted its budget inside the store (alphabetically ahead of
  // `apps/`, `docs/`, `packages/`) and globs returned 0 matches for patterns
  // that plainly match. Pinned by the preset-coherence test.
  '.pnpm-store',
  '.venv',
  'venv',
  '__pycache__',
  'node_modules',
  'coverage',
  'dist',
  'build',
  'playwright-report',
  'test-results',
  'reports',
  'storybook-static',
  'tmp',
  'temp',
  'out',
  'target',
  'vendor',
  'generated',
  '__generated__',
]);

const FULL_ROOT_SAFETY_EXCLUDED_DIRECTORY_SEGMENTS = new Set([
  '.git',
  '.turbo',
  '.cache',
  '.nyc_output',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.vercel',
  '.parcel-cache',
  '.vite',
  '.pnpm-store',
  'node_modules',
  'coverage',
  'dist',
  'build',
  'playwright-report',
  'test-results',
  'tmp',
  'temp',
  'out',
  'target',
]);

/**
 * DERIVED from the set above, never hand-copied (review of #2596). The
 * preset-coherence test iterates this, so a second literal would guard only the
 * names someone remembered to paste into it — which is precisely the omission
 * that let `.pnpm-store` through in the first place. Deriving makes the two
 * incapable of drifting apart.
 */
export const FULL_ROOT_SAFETY_EXCLUDED_DIRECTORY_SEGMENT_NAMES: readonly string[] = Object.freeze([
  ...FULL_ROOT_SAFETY_EXCLUDED_DIRECTORY_SEGMENTS,
]);

/**
 * BST-1246: the balanced policy's unconditional BY-NAME directory exclusions,
 * exported for the live-grep ripgrep prefilter. rg may prune ONLY directories
 * this policy hard-excludes by name at any depth — `resolveCandidate`
 * re-applies the same policy to every rg candidate, so pruning these keeps the
 * rg candidate set a strict SUPERSET of policy-kept files while cutting the
 * scan volume that blew the rg timeout on artifact trees (.vite, dist, …).
 * Frozen copy so live-grep cannot mutate the policy's own set.
 */
export const BALANCED_UNCONDITIONAL_EXCLUDED_DIRECTORY_SEGMENTS: readonly string[] = Object.freeze([
  ...BALANCED_EXCLUDED_DIRECTORY_SEGMENTS,
]);

const BALANCED_EXCLUDED_FILE_NAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'composer.lock',
  'gemfile.lock',
  'poetry.lock',
  'uv.lock',
  'podfile.lock',
]);

const BALANCED_EXCLUDED_SUFFIXES = ['.min.js', '.min.css', '.map', '.tsbuildinfo', '.log'];

const SPECIAL_TEXT_BASENAMES = new Set([
  'dockerfile',
  'makefile',
  'procfile',
  'gemfile',
  'rakefile',
  'brewfile',
  'justfile',
  'readme',
  'license',
  'licence',
  'copying',
  'changelog',
  'changes',
]);

const SPECIAL_TEXT_PREFIXES = [
  '.env',
  '.gitignore',
  '.gitattributes',
  '.npmrc',
  '.yarnrc',
  '.editorconfig',
];

// Nested-path exclusions the segment matcher can't express. These directories
// hold linked worktree copies of the whole repo; indexing them duplicates the
// corpus and pollutes semantic search with near-identical hits. Excluding the
// two-segment paths — rather than all of `.claude` or `.brainstrike` — keeps
// their useful config trees indexable. Applied to both presets: for balanced
// this is a content decision, for full-root a safety exclusion like node_modules.
const EXCLUDED_DIRECTORY_PATH_PREFIXES = ['.claude/worktrees', '.brainstrike/worktrees'] as const;

/**
 * BST-1246 companion to the segments export: the nested-path exclusions the
 * segment matcher can't express, applied by both presets.
 */
export const UNCONDITIONAL_EXCLUDED_DIRECTORY_PATH_PREFIXES: readonly string[] = Object.freeze([
  ...EXCLUDED_DIRECTORY_PATH_PREFIXES,
]);

/**
 * Watcher-facing forms of the same exclusions (BST-1342), both derived from
 * {@link UNCONDITIONAL_EXCLUDED_DIRECTORY_PATH_PREFIXES} so the "same rule as
 * the index side" claim is structural. Worktree churn flooding FSEvents was
 * the trigger for the 2026-08-17 run-5189 DB-saturation failure: every
 * overflow invalidated the root and each full refresh re-reconciled the
 * whole tree.
 *
 * Event FILTERING must stay root-relative (relativize, then reuse
 * {@link isExcludedBackgroundIndexingPath}) — a subscription root opened
 * INSIDE an excluded tree must watch normally. The native predicate below
 * exists for exactly that root-gating decision, not for event filtering.
 */
export const UNCONDITIONAL_EXCLUDED_PATH_IGNORE_GLOBS: readonly string[] = Object.freeze(
  UNCONDITIONAL_EXCLUDED_DIRECTORY_PATH_PREFIXES.flatMap((prefix) => [
    `**/${prefix}`,
    `**/${prefix}/**`,
  ])
);

const NATIVE_SEPARATOR = String.raw`[\\/]`;
const UNCONDITIONAL_EXCLUDED_NATIVE_PATH_REGEX = new RegExp(
  `(?:^|${NATIVE_SEPARATOR})(?:${UNCONDITIONAL_EXCLUDED_DIRECTORY_PATH_PREFIXES.map((prefix) =>
    prefix
      .split('/')
      .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
      .join(NATIVE_SEPARATOR)
  ).join('|')})(?:$|${NATIVE_SEPARATOR})`,
  'i'
);

/**
 * True when a NATIVE path (posix or windows separators, any case — the `i`
 * flag deliberately mirrors `matchesExcludedPathPrefix`'s lowercasing)
 * contains an unconditionally excluded tree at any depth. Segment-anchored:
 * near-miss names (`.claude/worktrees-backup`, `x.claude/worktrees`) never
 * match. Use it to gate a WHOLE SUBSCRIPTION ROOT ("is this root itself
 * inside an excluded tree?"); per-event filtering must relativize and reuse
 * {@link isExcludedBackgroundIndexingPath} instead.
 */
export function isUnconditionalExcludedNativePath(path: string): boolean {
  return UNCONDITIONAL_EXCLUDED_NATIVE_PATH_REGEX.test(path);
}

const PATH_SEPARATOR_CODE = '/'.charCodeAt(0);
const HARD_EXCLUDED_DIRECTORY_SUFFIXES = ['.app', '.framework'];

function matchesExcludedPathPrefix(relativePath: string): boolean {
  const lowerPath = relativePath.toLowerCase();
  return EXCLUDED_DIRECTORY_PATH_PREFIXES.some(
    (prefix) => lowerPath === prefix || lowerPath.startsWith(`${prefix}/`)
  );
}

/**
 * The excluded-path rule on its own, for consumers that must honour the SAME
 * exclusions without adopting the rest of an entry policy.
 *
 * The Explorer's token indexer is the motivating caller (BST-1207 widened it
 * from selection-only to visible + expanded directories, which walks the whole
 * display tree). It cannot use `shouldIncludeFile`: that gate also applies the
 * preset's size, extension and text rules, and the Explorer must keep counting
 * tokens for every row it actually SHOWS. Only the path exclusions are shared —
 * they mark trees nothing should ever index, at any preset, for any consumer.
 *
 * Both are preset-independent by construction: `EXCLUDED_DIRECTORY_PATH_PREFIXES`
 * is applied identically by the balanced and full-root file gates above, so
 * exposing it without a preset cannot drift from them.
 *
 * `relativePath` must be ROOT-RELATIVE and `/`-separated (no leading slash) —
 * the same contract as `BackgroundIndexingFileInput.relativePath`. An absolute
 * path never matches, so passing one silently indexes everything; that is why
 * callers build the path from the walk rather than trimming a prefix.
 */
export function isExcludedBackgroundIndexingPath(relativePath: string): boolean {
  return matchesExcludedPathPrefix(relativePath);
}

const balancedPathMatcher = createPathFilterMatcher(
  [],
  Array.from(BALANCED_EXCLUDED_DIRECTORY_SEGMENTS).map((segment) => `${segment}/**`)
);

export function getBackgroundIndexingPolicyOption(
  preset: BackgroundIndexingPolicyPreset
): BackgroundIndexingPolicyOption {
  const matchedOption = BACKGROUND_INDEXING_POLICY_OPTIONS.find(
    (option) => option.value === preset
  );
  if (matchedOption) {
    return matchedOption;
  }
  return BACKGROUND_INDEXING_POLICY_OPTIONS[0] as BackgroundIndexingPolicyOption;
}

function isSpecialTextFilename(fileName: string): boolean {
  const lowerName = fileName.toLowerCase();
  if (
    SPECIAL_TEXT_PREFIXES.some(
      (prefix) => lowerName === prefix || lowerName.startsWith(`${prefix}.`)
    )
  ) {
    return true;
  }
  return (
    SPECIAL_TEXT_BASENAMES.has(getBaseFilename(lowerName)) || SPECIAL_TEXT_BASENAMES.has(lowerName)
  );
}

function isWithinSizeLimit(fileSize: number | undefined): boolean {
  if (typeof fileSize !== 'number') {
    return true;
  }
  if (!Number.isFinite(fileSize) || fileSize < 0) {
    return false;
  }
  return fileSize <= DEFAULT_BACKGROUND_INDEXING_MAX_FILE_SIZE;
}

function shouldSkipBalancedDirectory(relativePath: string): boolean {
  if (matchesExcludedPathPrefix(relativePath)) {
    return true;
  }
  return shouldSkipDirectoryBySegment(relativePath, BALANCED_EXCLUDED_DIRECTORY_SEGMENTS);
}

function shouldSkipDirectoryBySegment(
  relativePath: string,
  excludedSegments: ReadonlySet<string>
): boolean {
  let segmentStart = 0;

  for (let index = 0; index <= relativePath.length; index += 1) {
    if (index !== relativePath.length && relativePath.charCodeAt(index) !== PATH_SEPARATOR_CODE) {
      continue;
    }

    const segment = relativePath.slice(segmentStart, index).trim();
    // Directory traversal calls this for every visited folder; scanning avoids
    // allocating a split/map/filter array per path.
    if (segment.length > 0) {
      const lowerSegment = segment.toLowerCase();
      if (
        excludedSegments.has(lowerSegment) ||
        HARD_EXCLUDED_DIRECTORY_SUFFIXES.some((suffix) => lowerSegment.endsWith(suffix))
      ) {
        return true;
      }
    }
    segmentStart = index + 1;
  }

  return false;
}

function shouldSkipFullRootDirectory(relativePath: string): boolean {
  if (matchesExcludedPathPrefix(relativePath)) {
    return true;
  }
  return shouldSkipDirectoryBySegment(relativePath, FULL_ROOT_SAFETY_EXCLUDED_DIRECTORY_SEGMENTS);
}

function shouldSkipBalancedFile(input: BackgroundIndexingFileInput): boolean {
  const lowerName = input.fileName.toLowerCase();
  if (BALANCED_EXCLUDED_FILE_NAMES.has(lowerName)) {
    return true;
  }
  if (BALANCED_EXCLUDED_SUFFIXES.some((suffix) => lowerName.endsWith(suffix))) {
    return true;
  }
  return balancedPathMatcher.shouldIncludeFile(input.relativePath) === false;
}

function shouldIncludeBalancedFile(input: BackgroundIndexingFileInput): boolean {
  if (matchesExcludedPathPrefix(input.relativePath)) {
    return false;
  }
  if (!isWithinSizeLimit(input.fileSize)) {
    return false;
  }
  if (isBinaryFile(input.fileName)) {
    return false;
  }
  if (shouldSkipBalancedFile(input)) {
    return false;
  }
  if (isSpecialTextFilename(input.fileName)) {
    return true;
  }
  return isTextFile(input.fileName);
}

function shouldIncludeFullRootFile(input: BackgroundIndexingFileInput): boolean {
  if (matchesExcludedPathPrefix(input.relativePath)) {
    return false;
  }
  if (!isWithinSizeLimit(input.fileSize)) {
    return false;
  }
  return !isBinaryFile(input.fileName);
}

export function createBackgroundIndexingEntryPolicy(
  config: BackgroundIndexingPolicyConfig
): BackgroundIndexingEntryPolicy {
  const option = getBackgroundIndexingPolicyOption(config.preset);

  if (config.preset === 'full-root') {
    return {
      description: option.description,
      label: option.label,
      preset: option.value,
      shouldIncludeFile: shouldIncludeFullRootFile,
      shouldTraverseDirectory: ({ relativePath }) => !shouldSkipFullRootDirectory(relativePath),
    };
  }

  return {
    description: option.description,
    label: option.label,
    preset: option.value,
    shouldIncludeFile: shouldIncludeBalancedFile,
    shouldTraverseDirectory: ({ relativePath }) => !shouldSkipBalancedDirectory(relativePath),
  };
}
