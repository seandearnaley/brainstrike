// @vitest-environment node
import {
  readFullTree,
  readFullTreeWithOptions,
  readFullTree as sharedReadFullTree,
  readFullTreeWithOptions as sharedReadFullTreeWithOptions,
} from '@brainstrike/file-system/directory-tree';
import { expect, it } from 'vitest';

it('retains the shared traversal authority through the legacy UI entry', () => {
  expect(readFullTree).toBe(sharedReadFullTree);
  expect(readFullTreeWithOptions).toBe(sharedReadFullTreeWithOptions);
});
