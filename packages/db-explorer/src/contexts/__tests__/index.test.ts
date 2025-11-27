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
    // 3 value exports (SemanticSearchContext, SemanticSearchProvider, useSemanticSearch)
    const valueExports = Object.keys(ContextsModule).filter(
      (key) => typeof ContextsModule[key as keyof typeof ContextsModule] !== 'undefined'
    );
    expect(valueExports.length).toBeGreaterThanOrEqual(3);
  });
});
