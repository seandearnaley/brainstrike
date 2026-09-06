import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NATIVE_TOOL_IDS } from '../native-tool-catalog';
import { defineNativeTool, InvalidNativeToolDefinitionError } from '../native-tools/define';
import { toToolSchemaDisplay } from '../native-tools/display';
import { NATIVE_TOOLS } from '../native-tools/index';
import { providerCompatibleInputSchema } from '../native-tools/schemas/provider-compatible-input';
import { QuerySelfInputSchema } from '../native-tools/schemas/schemas-diagnostics';
import { ReadWorkspaceFileInputSchema } from '../native-tools/schemas/schemas-workspace';
import { getToolSchemaDisplay, NATIVE_TOOL_SCHEMAS } from '../tool-schemas-display';

const PROBE_DEFAULTS = {
  category: 'retrieval',
  estimatedTokens: 1,
  loadingTier: 'deferred',
  requiresApproval: false,
  riskCategory: 'read',
} as const;

function probe(inputSchema: z.ZodType, display?: Readonly<Record<string, string>>) {
  return defineNativeTool({
    defaults: PROBE_DEFAULTS,
    description: 'probe',
    discovery: { family: 'diagnostics', namespace: 'database' },
    ...(display ? { display } : {}),
    id: 'brainstrike.displayProbe',
    inputSchema: providerCompatibleInputSchema(inputSchema),
    kind: 'desktop',
    returns: 'probe result',
    surfaces: ['desktop'],
  });
}

/**
 * The inspector display is DERIVED from the wire schema (BST-1646 step c),
 * replacing four hand-mirrored tables whose prose drifted from the Zod source.
 * These tests pin the derivation rules on a probe schema that exercises every
 * shape the catalog uses, then the real registry's parity by construction.
 */
describe('toToolSchemaDisplay', () => {
  it('derives name, type, required-ness, prose, enums, defaults, and bounds from the Zod schema', () => {
    const display = toToolSchemaDisplay(
      probe(
        z
          .object({
            count: z.number().int().positive().max(20).describe('Match cap (default 5)'),
            flag: z.boolean().default(false).describe('A flag'),
            items: z.array(z.string().min(1)).max(500).describe('Some paths'),
            mode: z.enum(['files', 'content']).describe('Output mode'),
            name: z.string().min(1).max(64).describe('A name'),
            nested: z.object({ inner: z.string() }).optional(),
            ratio: z.number().min(0).max(1).optional(),
          })
          .strict()
      )
    );
    expect(display.toolId).toBe('brainstrike.displayProbe');
    expect(display.description).toBe('probe');
    expect(display.returns).toBe('probe result');
    expect(display.parameters).toEqual([
      {
        description: 'Match cap (default 5)',
        max: 20,
        min: 1,
        name: 'count',
        required: true,
        type: 'number',
      },
      { default: false, description: 'A flag', name: 'flag', required: false, type: 'boolean' },
      {
        arrayItemType: 'string',
        description: 'Some paths',
        max: 500,
        name: 'items',
        required: true,
        type: 'array',
      },
      {
        description: 'Output mode',
        enumValues: ['files', 'content'],
        name: 'mode',
        required: true,
        type: 'enum',
      },
      {
        description: 'A name',
        maxLength: 64,
        minLength: 1,
        name: 'name',
        required: true,
        type: 'string',
      },
      { description: '', name: 'nested', required: false, type: 'object' },
      { description: '', max: 1, min: 0, name: 'ratio', required: false, type: 'number' },
    ]);
  });

  it('reads a nullish field as its underlying type (the built-in local model schema depends on this)', () => {
    const display = toToolSchemaDisplay(probe(ReadWorkspaceFileInputSchema));
    const byName = new Map(display.parameters.map((parameter) => [parameter.name, parameter]));
    expect(byName.get('cursor')).toMatchObject({ required: false, type: 'string' });
    expect(byName.get('path')).toMatchObject({ required: false, type: 'string' });
    expect(byName.get('maxChars')).toMatchObject({
      max: 50_000,
      min: 1,
      required: false,
      type: 'number',
    });
    // `.int()` alone declares no range: MAX_SAFE_INTEGER bounds are not shown.
    expect(byName.get('startLine')).toEqual({
      description:
        'First 1-based line; omit with cursor unless replaying the original value unchanged',
      min: 1,
      name: 'startLine',
      required: false,
      type: 'number',
    });
  });

  // Zod spells nullability two ways across versions and the resolver must not
  // care which it is handed. 4.4 emitted `anyOf: [{type:'string'},{type:'null'}]`;
  // 4.5 emits `type: ['string','null']`. The case above only proves whichever
  // form the pinned Zod happens to produce, so it would have gone quiet on the
  // 4.4 -> 4.5 bump rather than failing. These assert the shapes directly.
  it('resolves a JSON Schema type array the same way it resolves a nullable union', () => {
    const display = toToolSchemaDisplay(
      probe(
        z.object({
          bounded: z.string().min(2).max(8).nullable().describe('bounded nullable'),
          items: z.array(z.number()).nullish().describe('nullable array'),
          plain: z.string().nullable().describe('nullable string'),
        })
      )
    );
    const byName = new Map(display.parameters.map((parameter) => [parameter.name, parameter]));
    // Pin the assumption this case exists to cover: the installed Zod really
    // does emit the array spelling. If a later Zod goes back to `anyOf`, this
    // fails here and says so, instead of the case quietly passing through the
    // union path and proving nothing.
    expect(z.toJSONSchema(z.object({ p: z.string().nullable() })).properties?.['p']).toMatchObject({
      type: ['string', 'null'],
    });
    // `.nullable()` is still a required key — present, possibly null — where
    // `.nullish()` is optional. The type is what nullability must not change.
    expect(byName.get('plain')).toMatchObject({ required: true, type: 'string' });
    expect(byName.get('items')).toMatchObject({ arrayItemType: 'number', type: 'array' });
    // Facets still resolve off a nullable scalar rather than being dropped.
    expect(byName.get('bounded')).toMatchObject({ maxLength: 8, minLength: 2, type: 'string' });
  });

  it('merges a top-level discriminated union: every branch field, required only when required everywhere', () => {
    const display = toToolSchemaDisplay(
      probe(
        z.discriminatedUnion('action', [
          z.object({ action: z.literal('create'), title: z.string().describe('Title') }),
          z.object({ action: z.literal('list') }),
        ])
      )
    );
    expect(display.parameters).toEqual([
      {
        description: '',
        enumValues: ['create', 'list'],
        name: 'action',
        required: true,
        type: 'enum',
      },
      { description: 'Title', name: 'title', required: false, type: 'string' },
    ]);
  });

  it('uses inspector-only display prose for a parameter whose wire description is absent or terse', () => {
    const display = toToolSchemaDisplay(
      probe(z.object({ query: z.string(), topK: z.number().describe('Top K') }).strict(), {
        query: 'The search query.',
      })
    );
    expect(display.parameters.map((parameter) => parameter.description)).toEqual([
      'The search query.',
      'Top K',
    ]);
  });

  it('throws for display prose that names no parameter', () => {
    expect(() =>
      toToolSchemaDisplay(probe(z.object({ query: z.string() }).strict(), { qeury: 'typo' }))
    ).toThrow(InvalidNativeToolDefinitionError);
  });

  it('throws for an input schema that is not an object', () => {
    expect(() => toToolSchemaDisplay(probe(z.string()))).toThrow(InvalidNativeToolDefinitionError);
  });
});

describe('NATIVE_TOOL_SCHEMAS', () => {
  it('has exactly one derived display per catalog definition', () => {
    expect(Object.keys(NATIVE_TOOL_SCHEMAS)).toEqual(NATIVE_TOOL_IDS);
    for (const tool of NATIVE_TOOLS) {
      const display = NATIVE_TOOL_SCHEMAS[tool.id];
      expect(display.toolId).toBe(tool.id);
      expect(display.description).toBe(tool.description);
      expect(display.returns).toBe(tool.returns);
      expect(display.parameters.length).toBeGreaterThan(0);
      for (const parameter of display.parameters) {
        expect(parameter.description, `${tool.id}.${parameter.name} has no prose`).not.toBe('');
      }
    }
    expect(getToolSchemaDisplay('filesystem.list')).toBeUndefined();
  });

  it('derives each entry once and returns the same object on later reads', () => {
    const first = NATIVE_TOOL_SCHEMAS['brainstrike.grepSearch'];
    expect(NATIVE_TOOL_SCHEMAS['brainstrike.grepSearch']).toBe(first);
    expect(getToolSchemaDisplay('brainstrike.grepSearch')).toBe(first);
  });

  /**
   * Prose the parity spec this replaced kept pinning because it kept going
   * stale: `sql` is required by BOTH query and explain (runtime truth is
   * QUERY_SELF_ERROR_MESSAGES.missingSql), and `mode` must name every mode
   * it accepts. Now there is one prose source, so the pin is on the Zod text.
   */
  it('keeps the querySelf mode and sql prose honest against the schema', () => {
    const modeField = QuerySelfInputSchema.shape.mode;
    expect(modeField).toBeInstanceOf(z.ZodEnum);
    const modes = [...modeField.options].sort();
    expect(modes).toEqual([
      'describeTable',
      'explain',
      'lens',
      'listLenses',
      'listTables',
      'query',
    ]);
    const display = NATIVE_TOOL_SCHEMAS['brainstrike.querySelf'];
    const modeDescription =
      display.parameters.find((parameter) => parameter.name === 'mode')?.description ?? '';
    for (const mode of modes) {
      expect(modeDescription, `the mode description omits '${mode}'`).toContain(mode);
    }
    const sqlDescription =
      display.parameters.find((parameter) => parameter.name === 'sql')?.description ?? '';
    expect(sqlDescription).toContain('mode=query');
    expect(sqlDescription, 'sql is required for mode=explain too').toContain('mode=explain');
  });
});
