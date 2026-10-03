import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseLensFile } from '../lenses.js';
import { providerCompatibleInputSchema } from '../native-tools/schemas/provider-compatible-input.js';
import { QuerySelfInputSchema } from '../native-tools/schemas/schemas-diagnostics.js';

describe('querySelf target contract (BST-1924)', () => {
  it.each(['app', 'index'])('requires explicit %s routing in each mode', (target) => {
    for (const mode of QuerySelfInputSchema.shape.mode.options) {
      expect(QuerySelfInputSchema.parse({ mode, target })).toEqual({ mode, target });
    }
  });

  it.each([undefined, null, '', 'state', 'APP', ['app'], { target: 'index' }])(
    'rejects missing or invalid target %j without inferring an engine',
    (target) => {
      expect(
        QuerySelfInputSchema.safeParse({ mode: 'query', sql: 'SELECT 1', target }).success
      ).toBe(false);
    }
  );

  it('rejects a legacy call with no target property', () => {
    expect(QuerySelfInputSchema.safeParse({ mode: 'query', sql: 'SELECT 1' }).success).toBe(false);
  });

  it('keeps target a required scalar enum through strict provider conversion', () => {
    expect(z.toJSONSchema(QuerySelfInputSchema, { io: 'input' })).toMatchObject({
      properties: { target: { enum: ['app', 'index'], type: 'string' } },
      required: expect.arrayContaining(['mode', 'target']),
      type: 'object',
    });
    const boundary = providerCompatibleInputSchema(QuerySelfInputSchema);
    // Strict providers emit every declared field, including null optionals.
    const input = {
      analyze: null,
      lens: null,
      maxRows: null,
      mode: 'query',
      sql: 'SELECT 1',
      table: null,
      target: 'index',
      values: null,
    };
    expect(boundary.parse(input)).toEqual({ mode: 'query', sql: 'SELECT 1', target: 'index' });
    expect(boundary.safeParse({ ...input, target: null }).success).toBe(false);
  });

  it.each([
    ['callers-hybrid', 'index'],
    ['estimator-calibration', 'app'],
    ['experiment-outcome-correlation', 'app'],
    ['run-outcome-tool-correlation', 'app'],
    ['self-improvement-signal', 'app'],
    ['token-spend-by-tool', 'app'],
  ])('routes shipped %s to its declared %s store', (id, target) => {
    const fileName = `${id}.sql`;
    const content = readFileSync(
      new URL(`../../../../.brainstrike/lenses/${fileName}`, import.meta.url),
      'utf8'
    );
    const parsed = parseLensFile(fileName, content);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    expect(parsed.lens.target).toBe(target);
  });
});
