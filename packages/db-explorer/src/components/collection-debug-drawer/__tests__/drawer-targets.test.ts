// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { chunkRowToTarget, fileRowToTarget } from '../drawer-targets';

describe('fileRowToTarget', () => {
  it('projects a drawer file row onto the collection-file target kind', () => {
    expect(fileRowToTarget({ id: 'file-1', name: 'readme.md', path: 'docs/readme.md' })).toEqual({
      id: 'file-1',
      kind: 'collection-file',
      name: 'readme.md',
      path: 'docs/readme.md',
    });
  });

  it('preserves a missing path as null so Copy Path can gate itself off', () => {
    expect(fileRowToTarget({ id: 'file-1', name: 'readme.md', path: null }).path).toBeNull();
  });

  it('returns an immutable snapshot that does not alias the source row', () => {
    const row = { id: 'file-1', name: 'readme.md', path: 'docs/readme.md' };
    const target = fileRowToTarget(row);
    row.name = 'mutated.md';
    expect(target.name).toBe('readme.md');
  });
});

describe('chunkRowToTarget', () => {
  it('projects a drawer chunk row onto the chunk target kind', () => {
    expect(chunkRowToTarget({ content: 'hello world', id: 'chunk-1' })).toEqual({
      content: 'hello world',
      id: 'chunk-1',
      kind: 'chunk',
    });
  });

  it('keeps empty content empty so Copy Content hides itself rather than copying nothing', () => {
    expect(chunkRowToTarget({ content: '', id: 'chunk-1' }).content).toBe('');
  });

  it('returns an immutable snapshot that does not alias the source row', () => {
    const row = { content: 'hello', id: 'chunk-1' };
    const target = chunkRowToTarget(row);
    row.content = 'mutated';
    expect(target.content).toBe('hello');
  });
});
