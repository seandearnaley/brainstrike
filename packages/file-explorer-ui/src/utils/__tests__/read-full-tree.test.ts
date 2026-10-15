// @vitest-environment node
import {
  readFullTree as sharedReadFullTree,
  readFullTreeWithOptions as sharedReadFullTreeWithOptions,
} from '@brainstrike/file-system/directory-tree';
import { expect, it } from 'vitest';
import { readFullTree, readFullTreeWithOptions } from '../read-full-tree';

it('retains the shared traversal authority through the legacy UI entry', () => {
  expect(readFullTree).toBe(sharedReadFullTree);
  expect(readFullTreeWithOptions).toBe(sharedReadFullTreeWithOptions);
});
