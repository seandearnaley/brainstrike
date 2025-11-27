import { describe, expect, it } from 'vitest';
import * as ContextsModule from '../index';

describe('contexts module exports', () => {
  it('exports SemanticSearchContext', () => {
    expect(ContextsModule.SemanticSearchContext).toBeDefined();
  });

  it('exports SemanticSearchProvider', () => {
    expect(ContextsModule.SemanticSearchProvider).toBeDefined();
    expect(typeof ContextsModule.SemanticSearchProvider).toBe('function');
  });

  it('exports useSemanticSearch', () => {
    expect(ContextsModule.useSemanticSearch).toBeDefined();
    expect(typeof ContextsModule.useSemanticSearch).toBe('function');
  });

  it('has expected number of exports', () => {
    // Verify the 3 expected exports are present via static property access
    expect(ContextsModule.SemanticSearchContext).toBeDefined();
    expect(ContextsModule.SemanticSearchProvider).toBeDefined();
    expect(ContextsModule.useSemanticSearch).toBeDefined();
    // Module should have at least these 3 exports
    expect(Object.keys(ContextsModule).length).toBeGreaterThanOrEqual(3);
  });
});
