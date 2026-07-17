import {
  createFileTreeFromStructure,
  createNestedDirectoryStructure,
} from '@brainstrike/test-utils';
import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';

const countFiles = (node: IFileNode): number => {
  if (node.type === 'file') {
    return 1;
  }
  return (node.children ?? []).reduce((acc, child) => acc + countFiles(child), 0);
};

const getMaxDepth = (node: IFileNode): number => {
  let max = node.depth;
  if (node.children) {
    for (const child of node.children) {
      max = Math.max(max, getMaxDepth(child));
    }
  }
  return max;
};

describe('file-node factory helpers', () => {
  it('creates a nested directory structure with correct depth and file count', () => {
    const depth = 3;
    const filesPerLevel = 2;
    const root = createNestedDirectoryStructure('/', depth, filesPerLevel);

    expect(root.type).toBe('directory');
    expect(root.depth).toBe(0);

    const totalFiles = countFiles(root);
    const maxDepth = getMaxDepth(root);

    expect(totalFiles).toBe((depth + 1) * filesPerLevel);
    expect(maxDepth).toBe(depth);
  });

  it('converts a simple object structure into a file tree', () => {
    const structure = {
      'README.md': null,
      src: {
        'index.ts': null,
        utils: {
          'helper.ts': null,
        },
      },
    } as const;

    const nodes = createFileTreeFromStructure(structure);

    const src = nodes.find((n) => n.name === 'src');
    const readme = nodes.find((n) => n.name === 'README.md');
    expect(src?.type).toBe('directory');
    expect(src?.path).toBe('src');
    expect(src?.depth).toBe(0);
    const index = src?.children?.find((n) => n.name === 'index.ts');
    expect(index?.type).toBe('file');
    expect(index?.path).toBe('src/index.ts');
    expect(index?.depth).toBe(1);
    const utils = src?.children?.find((n) => n.name === 'utils');
    expect(utils?.type).toBe('directory');
    expect(utils?.path).toBe('src/utils');
    expect(utils?.depth).toBe(1);
    const helper = utils?.children?.find((n) => n.name === 'helper.ts');
    expect(helper?.type).toBe('file');
    expect(helper?.path).toBe('src/utils/helper.ts');
    expect(helper?.depth).toBe(2);

    expect(readme?.type).toBe('file');
    expect(readme?.path).toBe('README.md');
    expect(readme?.depth).toBe(0);
  });
});
