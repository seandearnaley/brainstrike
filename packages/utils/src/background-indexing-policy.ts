import { getBaseFilename, isBinaryFile, isTextFile } from './file-utils';
import { createPathFilterMatcher } from './filter-utils';

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
      'Indexes source, docs, and useful text files while skipping common generated, cache, lock, and minified artifacts.',
    label: 'Balanced',
    recommended: true,
    value: 'balanced',
  },
  {
    description:
      'Indexes every non-binary text file under the selected root except hard safety limits like oversized files.',
    label: 'Full root',
    recommended: false,
    value: 'full-root',
  },
] as const;

const BALANCED_EXCLUDED_DIRECTORY_SEGMENTS = new Set([
  '.git',
  '.turbo',
  '.cache',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.vercel',
  '.parcel-cache',
  '.vite',
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

const PATH_SEPARATOR_CODE = '/'.charCodeAt(0);
const HARD_EXCLUDED_DIRECTORY_SUFFIXES = ['.app', '.framework'];

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
