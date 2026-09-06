import { describe, expect, it } from 'vitest';
import { CLIENT_EXTENSIONS, ENGINE_EXTENSIONS } from '../src/pglite-factory.js';

describe('PGlite extension registry', () => {
  it('loads the documented engine extension set at every host', () => {
    expect(Object.keys(ENGINE_EXTENSIONS).sort()).toEqual(['pg_textsearch', 'pg_trgm', 'vector']);
    expect(Object.keys(CLIENT_EXTENSIONS)).toEqual(['live']);
  });
});
