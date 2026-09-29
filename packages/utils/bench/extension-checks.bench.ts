import { describe, test } from 'vitest';
import {
  getFileExtension,
  isBinaryExtension,
  isBinaryFile,
  isTextExtension,
  isTextFile,
} from '../src/file-utils.js';

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

const extensionInputs = {
  hidden: '.gitignore',
  hiddenWithExt: '/path/.env.local',
  long: '/home/user/projects/brainstrike/packages/utils/src/__tests__/file-utils.test.ts',
  multiDot: 'archive.tar.gz',
  noExt: 'Makefile',
  simple: 'file.txt',
  windows: 'C:\\Users\\name\\Documents\\report.pdf',
};

describe('getFileExtension', () => {
  test('simple filename', async ({ bench }) => {
    await bench('simple filename', () => {
      getFileExtension(extensionInputs.simple);
    }).run();
  });

  test('long path', async ({ bench }) => {
    await bench('long path', () => {
      getFileExtension(extensionInputs.long);
    }).run();
  });

  test('hidden file (no extension)', async ({ bench }) => {
    await bench('hidden file (no extension)', () => {
      getFileExtension(extensionInputs.hidden);
    }).run();
  });

  test('hidden file with extension', async ({ bench }) => {
    await bench('hidden file with extension', () => {
      getFileExtension(extensionInputs.hiddenWithExt);
    }).run();
  });

  test('no extension', async ({ bench }) => {
    await bench('no extension', () => {
      getFileExtension(extensionInputs.noExt);
    }).run();
  });

  test('multi-dot filename', async ({ bench }) => {
    await bench('multi-dot filename', () => {
      getFileExtension(extensionInputs.multiDot);
    }).run();
  });

  test('Windows path', async ({ bench }) => {
    await bench('Windows path', () => {
      getFileExtension(extensionInputs.windows);
    }).run();
  });
});

describe('isTextExtension', () => {
  test('normalized extensions', async ({ bench }) => {
    await bench('normalized extensions', () => {
      runExtensionChecks(normalizedTextExtensions, isTextExtension);
    }).run();
  });

  test('unnormalized extensions', async ({ bench }) => {
    await bench('unnormalized extensions', () => {
      runExtensionChecks(unnormalizedTextExtensions, isTextExtension);
    }).run();
  });
});

describe('isBinaryExtension', () => {
  test('normalized extensions', async ({ bench }) => {
    await bench('normalized extensions', () => {
      runExtensionChecks(normalizedBinaryExtensions, isBinaryExtension);
    }).run();
  });

  test('unnormalized extensions', async ({ bench }) => {
    await bench('unnormalized extensions', () => {
      runExtensionChecks(unnormalizedBinaryExtensions, isBinaryExtension);
    }).run();
  });
});

describe('file wrappers', () => {
  test('isTextFile', async ({ bench }) => {
    await bench('isTextFile', () => {
      runExtensionChecks(textFileNames, isTextFile);
    }).run();
  });

  test('isBinaryFile', async ({ bench }) => {
    await bench('isBinaryFile', () => {
      runExtensionChecks(binaryFileNames, isBinaryFile);
    }).run();
  });
});
