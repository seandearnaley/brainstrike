import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  effectToolInputSchema,
  isEffectToolInputSchema,
} from '../native-tools/schemas/effect-tool-input.js';
import { providerCompatibleInputSchema } from '../native-tools/schemas/provider-compatible-input.js';
import {
  toToolInputJsonSchema,
  validateToolInputValue,
} from '../native-tools/schemas/tool-input-schema.js';

/**
 * The derivation step ADR-0004's 2026-10-15 amendment adopts, one case per hard
 * shape — the shapes that differ between schema libraries are exactly the ones
 * a tool definition uses.
 *
 * Both dialects are checked. draft-07 is the provider wire (what
 * `prepareHostProviderTools` requests and what the recorded provider payloads
 * carry); draft-2020-12 is what the settings inspector reads. A derivation that
 * was right on one and wrong on the other would ship a tool that looks correct
 * in the UI and misbehaves with a model, or the reverse.
 */
const TARGETS = ['draft-07', 'draft-2020-12'] as const;

const bounded = (minimum: number, maximum: number) =>
  Schema.String.check(Schema.isMinLength(minimum), Schema.isMaxLength(maximum));

/**
 * Shapes where the two producers' JSON Schema is identical, so zod — the
 * library the recorded real-provider payloads were produced through — is a
 * direct oracle.
 */
const identical: ReadonlyArray<{
  readonly effect: Parameters<typeof effectToolInputSchema>[0];
  readonly name: string;
  readonly zod: z.ZodType;
}> = [
  {
    effect: Schema.Struct({
      path: Schema.String.annotate({ description: 'Workspace-relative path' }),
    }),
    name: 'a required string carrying the description the model reads',
    zod: z.object({ path: z.string().describe('Workspace-relative path') }).strict(),
  },
  {
    effect: Schema.Struct({
      status: Schema.Literals(['pending', 'in_progress', 'completed']).annotate({
        description: 'Task status; keep exactly one task in_progress',
      }),
    }),
    name: 'a string enum',
    zod: z
      .object({
        status: z
          .enum(['pending', 'in_progress', 'completed'])
          .describe('Task status; keep exactly one task in_progress'),
      })
      .strict(),
  },
  {
    effect: Schema.Struct({
      name: Schema.optionalKey(bounded(1, 128).annotate({ description: 'Directory name' })),
      root: bounded(1, 512).annotate({ description: 'Workspace root id' }),
    }),
    name: 'a bounded optional string beside a bounded required one',
    zod: z
      .object({
        name: z.string().min(1).max(128).optional().describe('Directory name'),
        root: z.string().min(1).max(512).describe('Workspace root id'),
      })
      .strict(),
  },
  {
    effect: Schema.Struct({
      tasks: Schema.Array(
        Schema.Struct({
          activeForm: bounded(1, 500).annotate({ description: 'Present-tense label' }),
          content: bounded(1, 500).annotate({ description: 'Imperative label' }),
          status: Schema.Literals(['pending', 'in_progress', 'completed']),
        })
      )
        .check(Schema.isMaxLength(50))
        .annotate({ description: 'Whole-list replace. Maximum 50 tasks.' }),
    }),
    name: 'a bounded array of nested objects (the manageTaskList shape)',
    zod: z
      .object({
        tasks: z
          .array(
            z
              .object({
                activeForm: z.string().min(1).max(500).describe('Present-tense label'),
                content: z.string().min(1).max(500).describe('Imperative label'),
                status: z.enum(['pending', 'in_progress', 'completed']),
              })
              .strict()
          )
          .max(50)
          .describe('Whole-list replace. Maximum 50 tasks.'),
      })
      .strict(),
  },
];

describe('effectToolInputSchema derivation', () => {
  it.each(identical)('matches zod exactly for $name', ({ effect, zod }) => {
    for (const target of TARGETS) {
      expect(toToolInputJsonSchema(effectToolInputSchema(effect), target), target).toEqual(
        toToolInputJsonSchema(providerCompatibleInputSchema(zod), target)
      );
    }
  });

  /**
   * Three shapes where the libraries choose different, equally valid draft-07
   * spellings. They are pinned rather than asserted equal to zod, because
   * claiming equality would be false and dropping the cases would hide the
   * difference from whoever converts the next tool.
   *
   * None of them changes what a provider accepts, and the wire is proven
   * separately: `provider-schema-selection.integration.test.ts` runs the real
   * converted tools through `prepareHostProviderTools` and compares against the
   * zod path, which is itself pinned to the recorded provider payloads.
   */
  it('pins the spellings that differ from zod, all of them valid draft-07', () => {
    // 1. Integers. zod's `.int()` adds safe-integer bounds; Effect's
    // `Schema.Int` does not. The RECORDED OpenAI payload for the `read` tool
    // carries a bare `{"type":"integer"}`, because Mastra's converter — not
    // `z.toJSONSchema` — produces the wire. So Effect matches the recording.
    expect(
      toToolInputJsonSchema(effectToolInputSchema(Schema.Struct({ line: Schema.Int })), 'draft-07')
    ).toMatchObject({ properties: { line: { type: 'integer' } } });
    expect(
      toToolInputJsonSchema(
        providerCompatibleInputSchema(z.object({ line: z.number().int() }).strict()),
        'draft-07'
      )
    ).toMatchObject({
      properties: { line: { maximum: Number.MAX_SAFE_INTEGER, type: 'integer' } },
    });

    // 2. Nullable. Effect spells it `anyOf: [T, null]`; zod 4.5+ spells it
    // `type: [T, 'null']`. `normalizeProviderNulls` and the catalog's provider
    // sweep already accept both (see the type-array case in the catalog spec).
    expect(
      toToolInputJsonSchema(
        effectToolInputSchema(Schema.Struct({ root: Schema.NullOr(Schema.String) })),
        'draft-07'
      )
    ).toMatchObject({ properties: { root: { anyOf: [{ type: 'string' }, { type: 'null' }] } } });

    // 3. Unions. Effect emits `anyOf` with a one-element `enum` discriminant
    // and closed branches; zod emits `oneOf` with `const` and open branches.
    // The catalog sweep rejects only `allOf`, and the normalizer reads both
    // keywords and both discriminant spellings.
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

  it('normalizes a provider null inside a discriminated-union branch, as zod does', () => {
    // The regression this guards: Effect spells a discriminant as a one-element
    // `enum`, so a normalizer that only knew `const` could not pick the branch
    // and left the null in place. Under OpenAI strict mode that is the ordinary
    // case, not an edge one — the model sends null for every optional it is not
    // using — so the two producers must agree here.
    const effect = effectToolInputSchema(
      Schema.Struct({
        operation: Schema.Union([
          Schema.Struct({ action: Schema.Literal('list'), offset: Schema.optionalKey(Schema.Int) }),
          Schema.Struct({ action: Schema.Literal('kill'), sessionId: Schema.String }),
        ]),
      })
    );
    const zod = providerCompatibleInputSchema(
      z
        .object({
          operation: z.discriminatedUnion('action', [
            z.object({ action: z.literal('list'), offset: z.number().int().optional() }),
            z.object({ action: z.literal('kill'), sessionId: z.string() }),
          ]),
        })
        .strict()
    );
    const providerInput = { operation: { action: 'list', offset: null } };
    const expected = { success: true, value: { operation: { action: 'list' } } };
    expect(validateToolInputValue(effect, structuredClone(providerInput))).toEqual(expected);
    expect(validateToolInputValue(zod, structuredClone(providerInput))).toEqual(expected);
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
    expect(isEffectToolInputSchema(providerCompatibleInputSchema(z.object({})))).toBe(false);
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
