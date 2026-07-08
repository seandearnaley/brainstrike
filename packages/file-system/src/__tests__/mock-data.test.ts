import { describe, expect, it } from 'vitest';
import {
  getTestDirectoryStructure,
  TEST_DIRECTORY_HANDLE_ID,
  TEST_DIRECTORY_PATH,
} from '../testing/mock-data';

describe('mock file-system test data', () => {
  it('builds the default fixture with expected paths and handle metadata', () => {
    const nodes = getTestDirectoryStructure();
    expect(nodes).toHaveLength(3);

    const first = nodes[0];
    expect(first).toMatchObject({
      handle: {
        id: 'mock-file-1',
        kind: 'file',
        platform: 'electron',
      },
      name: 'mock-file1.txt',
      path: `${TEST_DIRECTORY_PATH}/mock-file1.txt`,
      rootFolderId: TEST_DIRECTORY_HANDLE_ID,
      type: 'file',
    });

    const folder = nodes[2];
    expect(folder).toMatchObject({
      children: [],
      handle: {
        kind: 'directory',
        platform: 'electron',
      },
      name: 'mock-subfolder',
      path: `${TEST_DIRECTORY_PATH}/mock-subfolder`,
      rootFolderId: TEST_DIRECTORY_HANDLE_ID,
      type: 'directory',
    });
  });

  it('applies custom root path to all generated entries', () => {
    const customRoot = '/tmp/custom-root';
    const nodes = getTestDirectoryStructure(customRoot);

    for (const node of nodes) {
      expect(node.path.startsWith(customRoot)).toBe(true);
      expect(node.handle.path.startsWith(customRoot)).toBe(true);
    }
  });
});
