import { bench, describe } from 'vitest';
import { isBinaryExtension, isBinaryFile, isTextExtension, isTextFile } from '../src/file-utils';

const normalizedTextExtensions = ['ts', 'tsx', 'md', 'json'];
const normalizedBinaryExtensions = ['png', 'pdf', 'mp4', 'zip'];
const unnormalizedTextExtensions = ['.TS', '.Tsx', '.Md', 'JSON'];
const unnormalizedBinaryExtensions = ['.PNG', '.Pdf', '.MP4', 'ZIP'];

const textFileNames = ['src/main.ts', 'src/components/Button.tsx', 'README.md', 'config.json'];
const binaryFileNames = ['assets/logo.png', 'docs/spec.pdf', 'media/clip.mp4', 'archive/data.zip'];

function runExtensionChecks(
  values: readonly string[],
  checker: (value: string) => boolean
): number {
  let hits = 0;
  for (const value of values) {
    if (checker(value)) {
      hits += 1;
    }
  }
  return hits;
}

describe('isTextExtension', () => {
  bench('normalized extensions', () => {
    runExtensionChecks(normalizedTextExtensions, isTextExtension);
  });

  bench('unnormalized extensions', () => {
    runExtensionChecks(unnormalizedTextExtensions, isTextExtension);
  });
});

describe('isBinaryExtension', () => {
  bench('normalized extensions', () => {
    runExtensionChecks(normalizedBinaryExtensions, isBinaryExtension);
  });

  bench('unnormalized extensions', () => {
    runExtensionChecks(unnormalizedBinaryExtensions, isBinaryExtension);
  });
});

describe('file wrappers', () => {
  bench('isTextFile', () => {
    runExtensionChecks(textFileNames, isTextFile);
  });

  bench('isBinaryFile', () => {
    runExtensionChecks(binaryFileNames, isBinaryFile);
  });
});
