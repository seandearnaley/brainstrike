import { describe, expect, it } from 'vitest';
import * as collectionBrowserModule from '../collection-browser/index';

describe('collection-browser module exports', () => {
  it('exports CollectionBrowser', () => {
    expect(collectionBrowserModule.CollectionBrowser).toBeDefined();
  });

  it('exports FilterControls', () => {
    expect(collectionBrowserModule.FilterControls).toBeDefined();
  });

  it('exports FilterChip', () => {
    expect(collectionBrowserModule.FilterChip).toBeDefined();
  });

  it('exports BulkActionBar', () => {
    expect(collectionBrowserModule.BulkActionBar).toBeDefined();
  });

  it('exports SearchModeBar', () => {
    expect(collectionBrowserModule.SearchModeBar).toBeDefined();
  });

  it('exports SearchConfigPanel', () => {
    expect(collectionBrowserModule.SearchConfigPanel).toBeDefined();
  });

  it('exports NodeInspector', () => {
    expect(collectionBrowserModule.NodeInspector).toBeDefined();
  });

  it('exports type configuration', () => {
    expect(collectionBrowserModule.NODE_TYPE_CONFIG).toBeDefined();
    expect(collectionBrowserModule.EMBEDDING_STATUS_CONFIG).toBeDefined();
  });

  it('exports multiple items', () => {
    const exportedKeys = Object.keys(collectionBrowserModule);
    expect(exportedKeys.length).toBeGreaterThanOrEqual(5);
  });
});
