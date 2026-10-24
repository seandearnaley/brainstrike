import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { NATIVE_TOOLS } from '../native-tools/index.js';
import {
  effectToolInputSchema,
  isEffectToolInputSchema,
} from '../native-tools/schemas/effect-tool-input.js';
import {
  toToolInputJsonSchema,
  validateToolInputValue,
} from '../native-tools/schemas/tool-input-schema.js';
import { encodeToolOutputArtifactCursor } from '../tool-output-artifact.js';

describe('effectToolInputSchema derivation', () => {
  /** The draft-07 spellings a provider receives; all of them are valid draft-07. */
  it('pins the draft-07 spellings of integers, nullables and unions', () => {
    // 1. Integers: a bare `{"type":"integer"}`, as the recorded OpenAI payload
    // for the `read` tool carries.
    expect(
      toToolInputJsonSchema(effectToolInputSchema(Schema.Struct({ line: Schema.Int })), 'draft-07')
    ).toMatchObject({ properties: { line: { type: 'integer' } } });

    // 2. Nullable: `anyOf: [T, null]`.
    expect(
      toToolInputJsonSchema(
        effectToolInputSchema(Schema.Struct({ root: Schema.NullOr(Schema.String) })),
        'draft-07'
      )
    ).toMatchObject({ properties: { root: { anyOf: [{ type: 'string' }, { type: 'null' }] } } });

    // 3. Unions: `anyOf` with a one-element `enum` discriminant and closed
    // branches. The catalog sweep rejects only `allOf`, and the normalizer
    // reads `anyOf`/`oneOf` and `enum`/`const` discriminants.
    expect(
      toToolInputJsonSchema(
        effectToolInputSchema(
          Schema.Struct({
            operation: Schema.Union([
              Schema.Struct({ action: Schema.Literal('list') }),
              Schema.Struct({ action: Schema.Literal('kill'), sessionId: Schema.String }),
            ]),
          })
        ),
        'draft-07'
      )
    ).toMatchObject({
      properties: {
        operation: {
          anyOf: [
            { properties: { action: { enum: ['list'] } } },
            { properties: { action: { enum: ['kill'] } } },
          ],
        },
      },
    });
  });

  it('normalizes a provider null inside a discriminated-union branch', () => {
    // The regression this guards: Effect spells a discriminant as a one-element
    // `enum`, so a normalizer that only knew `const` could not pick the branch
    // and left the null in place. Under OpenAI strict mode that is the ordinary
    // case, not an edge one — the model sends null for every optional it is not
    // using.
    const effect = effectToolInputSchema(
      Schema.Struct({
        operation: Schema.Union([
          Schema.Struct({ action: Schema.Literal('list'), offset: Schema.optionalKey(Schema.Int) }),
          Schema.Struct({ action: Schema.Literal('kill'), sessionId: Schema.String }),
        ]),
      })
    );
    expect(validateToolInputValue(effect, { operation: { action: 'list', offset: null } })).toEqual(
      { success: true, value: { operation: { action: 'list' } } }
    );
  });

  it('keeps a multi-value enum a constrained field, not a discriminant', () => {
    // `manageWorktree`'s envelope has `action: enum[create, archive]`. Reading
    // that as a discriminant would make the envelope select a branch of itself.
    const schema = effectToolInputSchema(
      Schema.Struct({
        action: Schema.Literals(['create', 'archive']),
        branch: Schema.optionalKey(Schema.String),
      })
    );
    expect(validateToolInputValue(schema, { action: 'archive', branch: null })).toEqual({
      success: true,
      value: { action: 'archive' },
    });
  });

  it('refuses a target neither dialect supports instead of approximating one', () => {
    // Ignoring the requested target would answer with a different draft's
    // document — plausible-looking and wrong.
    const schema = effectToolInputSchema(Schema.Struct({ path: Schema.String }));
    expect(() => schema['~standard'].jsonSchema.input({ target: 'openapi-3.0' })).toThrow(
      /Unsupported tool JSON Schema target/u
    );
    expect(() => schema['~standard'].jsonSchema.input({ target: 'draft-04' })).toThrow();
  });

  it('answers each supported dialect with its own document', () => {
    const schema = effectToolInputSchema(Schema.Struct({ path: Schema.String }));
    expect(schema['~standard'].jsonSchema.input({ target: 'draft-07' })).toMatchObject({
      $schema: 'http://json-schema.org/draft-07/schema#',
    });
    expect(schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' })).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
    });
  });

  it('closes every derived object, which Effect does not do by default', () => {
    // Effect's emitter defaults additionalProperties to TRUE; the producer
    // pairs `onExcessProperty: 'error'` across derivation AND decoding.
    const schema = effectToolInputSchema(
      Schema.Struct({ nested: Schema.Struct({ leaf: Schema.String }), top: Schema.String })
    );
    const json = toToolInputJsonSchema(schema, 'draft-07') as {
      additionalProperties: unknown;
      properties: { nested: { additionalProperties: unknown } };
    };
    expect(json.additionalProperties).toBe(false);
    expect(json.properties.nested.additionalProperties).toBe(false);
    expect(validateToolInputValue(schema, { surprise: 1, top: 'a' }).success).toBe(false);
  });

  it('hands each caller its own copy, so one compat layer cannot rewrite another', () => {
    const schema = effectToolInputSchema(Schema.Struct({ path: Schema.String }));
    const first = schema['~standard'].jsonSchema.input({ target: 'draft-07' });
    first['additionalProperties'] = 'mutated';
    expect(schema['~standard'].jsonSchema.input({ target: 'draft-07' })).toMatchObject({
      additionalProperties: false,
    });
  });

  it('recognizes its own output and nothing else', () => {
    expect(isEffectToolInputSchema(effectToolInputSchema(Schema.Struct({})))).toBe(true);
    expect(isEffectToolInputSchema({ '~standard': { vendor: 'zod', version: 1 } })).toBe(false);
    expect(isEffectToolInputSchema(undefined)).toBe(false);
  });

  it("leaves the caller's value untouched when normalizing provider nulls", () => {
    const schema = effectToolInputSchema(
      Schema.Struct({ name: Schema.optionalKey(Schema.String), path: Schema.String })
    );
    const providerInput = { name: null, path: '/src/main.ts' };
    expect(validateToolInputValue(schema, providerInput)).toEqual({
      success: true,
      value: { path: '/src/main.ts' },
    });
    expect(providerInput).toEqual({ name: null, path: '/src/main.ts' });
  });
});

const cursor = encodeToolOutputArtifactCursor(
  {
    byteLength: 12,
    expiresAt: '2099-01-01T00:00:00.000Z',
    format: 'text',
    id: 'parity-artifact',
  },
  0
);

// Extend this table for E02: each row exercises the registered producer, not a
// schema recreated inside the test. The catalog test separately requires Effect.
const boundaryCases: ReadonlyArray<
  readonly [string, Record<string, unknown>, boolean, (readonly PropertyKey[])?]
> = [
  [
    'hybridSearch',
    {
      filePaths: ['src/a.ts'],
      ftsWeight: 0,
      limit: 100,
      query: 'context',
      vectorThreshold: 1,
      vectorWeight: 2,
    },
    true,
  ],
  ['hybridSearch', { filePaths: new Array(501).fill('a'), query: 'context' }, false],
  ['hybridSearch', { filePaths: [''], query: 'context' }, false, ['filePaths', 0]],
  ['hybridSearch', { limit: 1.5, query: 'context' }, false, ['limit']],
  ['hybridSearch', { query: 'context', vectorThreshold: -0.1 }, false],
  ['hybridSearch', { ftsWeight: 2.1, query: 'context' }, false],
  ['hybridSearch', { query: 'context', root: '' }, false],
  [
    'queryEmbeddingSpace',
    {
      filePaths: new Array(5000).fill('a'),
      maxChunks: 100,
      query: 'context',
      root: '',
      tokenBudget: 200_000,
    },
    true,
  ],
  ['queryEmbeddingSpace', { filePaths: new Array(5001).fill('a'), query: 'context' }, false],
  ['queryEmbeddingSpace', { query: 'context', tokenBudget: 200_001 }, false],
  ['grepSearch', { contextLines: 5, isRegex: false, offset: 2000, pattern: 'a(b' }, true],
  ['grepSearch', { isRegex: true, pattern: 'a(b' }, false, ['pattern']],
  ['grepSearch', { filePaths: new Array(1001).fill('a'), pattern: 'ab' }, false],
  ['grepSearch', { contextLines: 6, pattern: 'ab' }, false],
  ['globWorkspace', { limit: 1000, offset: 100_000, pattern: '*.ts' }, true],
  ['globWorkspace', { offset: 100_001, pattern: '*.ts' }, false],
  ['webSearch', { maxResults: 10, query: 'ab' }, true],
  ['webSearch', { query: 'a' }, false],
  ['webSearch', { query: '🙂' }, false],
  ['hybridSearch', { ftsWeight: Number.NaN, query: 'context' }, false],
  ['hybridSearch', { ftsWeight: Number.POSITIVE_INFINITY, query: 'context' }, false],
  ['webSearch', { query: 'a'.repeat(401) }, false],
  ['webSearch', { maxResults: 11, query: 'ab' }, false],
  ['webExtract', { urls: ['https://example.com'] }, true],
  ['webExtract', { urls: [] }, false],
  ['webExtract', { urls: new Array(6).fill('https://example.com') }, false],
  ['webExtract', { urls: ['short'] }, false, ['urls', 0]],
  ['lspInspect', { line: 1, match: 'symbol', path: 'src/a.ts' }, true],
  ['lspInspect', { line: 0, match: 'symbol', path: 'src/a.ts' }, false],
  ['lspInspect', { line: Number.MAX_SAFE_INTEGER + 1, match: 'symbol', path: 'src/a.ts' }, false],
  ['readToolOutputArtifact', { cursor, maxBytes: 4 }, true],
  ['readToolOutputArtifact', { cursor, maxBytes: 8000, pattern: 'a(b' }, true],
  ['readToolOutputArtifact', { cursor, maxBytes: 3 }, false],
  ['readToolOutputArtifact', { cursor, maxBytes: 8001 }, false],
  ['readToolOutputArtifact', { cursor: 'malformed' }, false, ['cursor']],
  ['readToolOutputArtifact', { cursor, isRegex: true }, false, ['isRegex']],
  ['readToolOutputArtifact', { caseSensitive: false, cursor }, false, ['caseSensitive']],
  ['readToolOutputArtifact', { cursor, isRegex: true, pattern: 'a(b' }, false, ['pattern']],
] as const;

function registeredSchema(name: string) {
  const tool = NATIVE_TOOLS.find((entry) => entry.id === `brainstrike.${name}`);
  if (!tool) {
    throw new Error(`Missing tool: ${name}`);
  }
  return tool.inputSchema;
}

describe('registered search/artifact boundaries', () => {
  it.each(boundaryCases.map(([name, input, accepted, path]) => ({ accepted, input, name, path })))(
    '$name boundary case $#',
    ({ name, input, accepted, path }) => {
      const result = validateToolInputValue(registeredSchema(name), input);
      expect(result.success).toBe(accepted);
      if (path && !result.success) {
        expect(result.issues.map((issue) => issue.path)).toContainEqual(path);
      }
    }
  );

  it.each(boundaryCases.filter((entry) => entry[2]).map(([name, input]) => ({ input, name })))(
    '$name rejects extra fields and normalizes optional provider nulls',
    ({ name, input }) => {
      const schema = registeredSchema(name);
      expect(validateToolInputValue(schema, { ...input, unexpected: true }).success).toBe(false);
      const json = toToolInputJsonSchema(schema, 'draft-07');
      const required = json['required'] as string[];
      const properties = json['properties'] as Record<string, unknown>;
      const providerInput = {
        ...input,
        ...Object.fromEntries(
          Object.keys(properties)
            .filter((key) => !(required.includes(key) || key in input))
            .map((key) => [key, null])
        ),
      };
      expect(validateToolInputValue(schema, providerInput)).toEqual(
        validateToolInputValue(schema, input)
      );
    }
  );

  it('keeps decoding defaults synchronous and fills absent or provider-null keys', () => {
    const schema = effectToolInputSchema(
      Schema.Struct({
        maxChars: Schema.Int.annotate({ default: 6000 }).pipe(
          Schema.withDecodingDefaultKey(Effect.succeed(6000))
        ),
      })
    );
    for (const input of [{}, { maxChars: null }]) {
      const result = schema['~standard'].validate(input);
      expect(result).not.toBeInstanceOf(Promise);
      expect(result).toEqual({ value: { maxChars: 6000 } });
    }
    expect(toToolInputJsonSchema(schema, 'draft-07')).toMatchObject({
      properties: { maxChars: { default: 6000 } },
    });
  });

  it('bounds astral strings by code point', () => {
    expect(
      validateToolInputValue(registeredSchema('webSearch'), { query: '🙂'.repeat(400) }).success
    ).toBe(true);
    expect(
      validateToolInputValue(registeredSchema('webSearch'), { query: '🙂'.repeat(401) }).success
    ).toBe(false);
  });
});

describe('completed native tool schema ownership', () => {
  it('registers every catalog input with the single Effect producer', () => {
    expect(NATIVE_TOOLS.length).toBeGreaterThan(0);
    expect(
      NATIVE_TOOLS.filter((tool) => !isEffectToolInputSchema(tool.inputSchema)).map(
        (tool) => tool.id
      )
    ).toEqual([]);
  });
});
