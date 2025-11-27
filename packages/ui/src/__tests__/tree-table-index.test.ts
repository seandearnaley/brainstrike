import { describe, expect, it } from 'vitest';
import * as treeTableModule from '../tree-table/index';

describe('tree-table module exports', () => {
  it('exports TreeTable', () => {
    expect(treeTableModule.TreeTable).toBeDefined();
  });

  it('exports TreeTableRow', () => {
    expect(treeTableModule.TreeTableRow).toBeDefined();
  });

  it('exports flattenTree utility', () => {
    expect(treeTableModule.flattenTree).toBeDefined();
    expect(typeof treeTableModule.flattenTree).toBe('function');
  });

  it('exports flattenTreeRecursive utility', () => {
    expect(treeTableModule.flattenTreeRecursive).toBeDefined();
    expect(typeof treeTableModule.flattenTreeRecursive).toBe('function');
  });

  it('exports findNodeById utility', () => {
    expect(treeTableModule.findNodeById).toBeDefined();
    expect(typeof treeTableModule.findNodeById).toBe('function');
  });

  it('exports getVisibleNodeCount utility', () => {
    expect(treeTableModule.getVisibleNodeCount).toBeDefined();
    expect(typeof treeTableModule.getVisibleNodeCount).toBe('function');
  });

  it('exports useTreeKeyboard hook', () => {
    expect(treeTableModule.useTreeKeyboard).toBeDefined();
    expect(typeof treeTableModule.useTreeKeyboard).toBe('function');
  });

  it('exports multiple items', () => {
    const exportedKeys = Object.keys(treeTableModule);
    expect(exportedKeys.length).toBeGreaterThanOrEqual(10);
  });
});
