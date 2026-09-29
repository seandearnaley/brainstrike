import { describe, expect, it } from 'vitest';
import { buildSectionNodes, createCatalogNodeCache } from '../catalog-nodes';
import { makeCatalogRow } from './catalog-test-harness';

describe('createCatalogNodeCache', () => {
  it('builds a model node with a details child', () => {
    const row = makeCatalogRow({ id: 'gpt-a' });
    const nodes = createCatalogNodeCache()(row);
    expect(nodes.model).toMatchObject({
      depth: 0,
      hasChildren: true,
      id: 'gpt-a',
      parentId: null,
      type: 'model',
    });
    expect(nodes.detail).toMatchObject({
      depth: 1,
      hasChildren: false,
      id: 'gpt-a::details',
      parentId: 'gpt-a',
      type: 'detail',
    });
    expect(nodes.model.data).toEqual({ kind: 'model', row });
    expect(nodes.detail.data).toEqual({ kind: 'detail', row });
  });

  it('returns the SAME nodes for the same row identity, and new nodes for a replaced row', () => {
    const getNodes = createCatalogNodeCache();
    const row = makeCatalogRow({ id: 'gpt-a' });
    expect(getNodes(row)).toBe(getNodes(row));
    expect(getNodes({ ...row, enabled: true }).model).not.toBe(getNodes(row).model);
  });
});

describe('buildSectionNodes', () => {
  it('lists each model node followed by its details node', () => {
    const getNodes = createCatalogNodeCache();
    const rows = [makeCatalogRow({ id: 'a' }), makeCatalogRow({ id: 'b' })];
    expect(buildSectionNodes(rows, getNodes).map((node) => node.id)).toEqual([
      'a',
      'a::details',
      'b',
      'b::details',
    ]);
  });
});
