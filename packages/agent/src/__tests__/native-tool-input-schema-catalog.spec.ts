import { DESKTOP_NATIVE_TOOL_IDS } from '@brainstrike/assistant-contract';
import {
  isEffectToolInputSchema,
  toToolInputJsonSchema,
  validateToolInputValue,
} from '@brainstrike/assistant-contract/native-tool-schemas';
import { standardSchemaToJSONSchema, toStandardSchema } from '@mastra/core/schema';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { providerCompatibleInputSchema } from '../tools/provider-compatible-input';
import * as toolSchemas from '../tools/schemas';

const PROVIDER_JSON_SCHEMA_OPTIONS = {
  cycles: 'throw',
  io: 'input',
  reused: 'inline',
} as const;

function isJsonSchemaRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonPathProperty(path: string, property: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(property)
    ? `${path}.${property}`
    : `${path}[${JSON.stringify(property)}]`;
}

function collectUnsupportedProviderSchemaShapes(schema: unknown, toolId: string): string[] {
  const findings: string[] = [];

  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        visit(entry, `${path}[${index}]`);
      });
      return;
    }
    if (!isJsonSchemaRecord(value)) {
      return;
    }

    if (Array.isArray(value['allOf'])) {
      findings.push(`${toolId} at ${path}.allOf: allOf intersections are unsupported`);
    }
    if (isJsonSchemaRecord(value['additionalProperties'])) {
      findings.push(
        `${toolId} at ${path}.additionalProperties: structured additionalProperties is unsupported`
      );
    }

    for (const [property, child] of Object.entries(value)) {
      visit(child, jsonPathProperty(path, property));
    }
  };

  visit(schema, '$');
  return findings;
}

describe('native tool input schema catalog', () => {
  it('exports exact desktop-native parity without stale web or Mastra-owned skill entries', () => {
    const registry = Reflect.get(toolSchemas, 'NATIVE_TOOL_INPUT_SCHEMAS');
    expect(
      registry,
      'NATIVE_TOOL_INPUT_SCHEMAS must be the exported agent-only Zod schema source'
    ).toEqual(expect.any(Object));
    if (!(registry && typeof registry === 'object')) {
      throw new TypeError('NATIVE_TOOL_INPUT_SCHEMAS must be an object');
    }

    // The catalog's inline snapshot (packages/assistant-contract native-tools.test.ts)
    // is the ONE hand-maintained id list; this map is derived from the same definitions.
    expect(Object.keys(registry)).toEqual([...DESKTOP_NATIVE_TOOL_IDS]);
    expect(registry).not.toHaveProperty('web.echo');
    expect(registry).not.toHaveProperty('skill');
    expect(registry).not.toHaveProperty('skill_read');
    expect(registry).not.toHaveProperty('skill_search');
  });

  it('accepts compact hosted-provider continuations and rejects identity overrides', () => {
    const schema = toolSchemas.NATIVE_TOOL_INPUT_SCHEMAS['brainstrike.readWorkspaceFile'];
    const cursor = 'rfh_abcdefghijklmnopqrstuv';

    expect(schema.safeParse({ path: '/src/main.ts' }).success).toBe(true);
    expect(schema.safeParse({ cursor, maxChars: 6000 }).success).toBe(true);
    expect(
      schema.safeParse({
        cursor,
        endLine: 77,
        maxChars: 6000,
        path: null,
        root: null,
        startLine: null,
      }).success
    ).toBe(true);
    expect(schema.safeParse({ cursor, path: '/src/main.ts' }).success).toBe(false);
    expect(schema.safeParse({ cursor, root: 'other-root' }).success).toBe(false);

    expect(
      toolSchemas.ReadWorkspaceFileInputSchema.safeParse({
        cursor: null,
        endLine: null,
        maxChars: null,
        path: '/src/main.ts',
        root: null,
        startLine: null,
      }).success
    ).toBe(true);
  });

  it('accepts provider null for optional fields, normalizes it to omission, and rejects malformed values', () => {
    const cases: ReadonlyArray<{
      expected: Record<string, unknown>;
      invalidInput: Record<string, unknown>;
      providerInput: Record<string, unknown>;
      toolId: keyof typeof toolSchemas.NATIVE_TOOL_INPUT_SCHEMAS;
    }> = [
      {
        expected: { path: '/src/main.ts' },
        invalidInput: { path: 42 },
        providerInput: {
          cursor: null,
          endLine: null,
          maxChars: null,
          path: '/src/main.ts',
          root: null,
          startLine: null,
        },
        toolId: 'brainstrike.readWorkspaceFile',
      },
      {
        expected: { content: 'export {};', path: '/src/new.ts' },
        invalidInput: { content: 'export {};', path: '/src/new.ts', root: 42 },
        providerInput: { content: 'export {};', path: '/src/new.ts', root: null },
        toolId: 'brainstrike.writeWorkspaceFile',
      },
      {
        expected: {},
        invalidInput: { includeHidden: 'false' },
        providerInput: {
          depth: null,
          detail: null,
          includeDirectories: null,
          includeFiles: null,
          includeHidden: null,
          maxEntries: null,
          offset: null,
          path: null,
          root: null,
        },
        toolId: 'brainstrike.readWorkspaceDirectory',
      },
      {
        expected: { pattern: 'needle' },
        invalidInput: { caseSensitive: 'false', pattern: 'needle' },
        providerInput: {
          caseSensitive: null,
          contextLines: null,
          filePaths: null,
          isRegex: null,
          maxResults: null,
          offset: null,
          outputMode: null,
          pattern: 'needle',
          root: null,
        },
        toolId: 'brainstrike.grepSearch',
      },
      {
        expected: { command: 'pwd' },
        invalidInput: { command: 'pwd', timeoutMs: 'slow' },
        providerInput: { command: 'pwd', cwd: null, root: null, timeoutMs: null },
        toolId: 'brainstrike.executeCommand',
      },
      {
        expected: { filter: 'interactive', maxChars: 6000 },
        invalidInput: { filter: 'interactive', maxChars: 'many' },
        providerInput: { filter: null, maxChars: null },
        toolId: 'brainstrike.browserReadPage',
      },
    ];

    // Read through the producer-neutral accessor: the cases span both
    // producers (`browserReadPage` is Effect-authored, the rest still zod) and
    // `safeParse` is a zod-only API, so naming it here would make this guard
    // pass or fail on which library authored the tool rather than on whether
    // provider `null` normalized to omission.
    for (const testCase of cases) {
      const schema = toolSchemas.NATIVE_TOOL_INPUT_SCHEMAS[testCase.toolId];
      const parsed = validateToolInputValue(schema, testCase.providerInput);

      expect(
        parsed.success,
        parsed.success ? testCase.toolId : `${testCase.toolId}: ${JSON.stringify(parsed.issues)}`
      ).toBe(true);
      if (!parsed.success) {
        continue;
      }
      expect(parsed.value, testCase.toolId).toEqual(testCase.expected);
      expect(validateToolInputValue(schema, testCase.invalidInput).success, testCase.toolId).toBe(
        false
      );
    }

    expect(
      toolSchemas.NATIVE_TOOL_INPUT_SCHEMAS['brainstrike.writeWorkspaceFile'].safeParse({
        content: null,
        path: '/src/new.ts',
      }).success
    ).toBe(false);
    expect(
      toolSchemas.NATIVE_TOOL_INPUT_SCHEMAS['brainstrike.grepSearch'].safeParse({ pattern: null })
        .success
    ).toBe(false);
    expect(
      validateToolInputValue(toolSchemas.NATIVE_TOOL_INPUT_SCHEMAS['brainstrike.executeCommand'], {
        command: null,
      }).success
    ).toBe(false);
    expect(
      toolSchemas.NATIVE_TOOL_INPUT_SCHEMAS['brainstrike.writeWorkspaceFile'].safeParse({
        content: 'export {};',
        path: '/src/new.ts',
        unknownProviderField: null,
      }).success
    ).toBe(false);

    // submitPlan is Effect-authored, so it is read through the neutral
    // accessor. The nested `detail: null` inside an array item is the point:
    // normalization has to walk into `steps[]` for the Effect producer too.
    expect(
      validateToolInputValue(toolSchemas.NATIVE_TOOL_INPUT_SCHEMAS['brainstrike.submitPlan'], {
        overview: 'Implement the contract.',
        risks: null,
        steps: [{ detail: null, title: 'Implement' }],
        title: 'Provider compatibility',
        verification: null,
      })
    ).toEqual({
      success: true,
      value: {
        overview: 'Implement the contract.',
        steps: [{ title: 'Implement' }],
        title: 'Provider compatibility',
      },
    });

    // The nested `offset: null` inside the action union is the point here:
    // normalization has to select the `action: 'list'` branch from the
    // Effect producer's `anyOf` + one-element `enum` discriminant, where the
    // zod version advertised `oneOf` + `const`.
    expect(
      validateToolInputValue(
        toolSchemas.NATIVE_TOOL_INPUT_SCHEMAS['brainstrike.inspectCommandSessions'],
        { operation: { action: 'list', offset: null }, root: null }
      )
    ).toEqual({ success: true, value: { operation: { action: 'list' } } });
    expect(
      validateToolInputValue(toolSchemas.NATIVE_TOOL_INPUT_SCHEMAS['brainstrike.submitPlan'], {
        overview: 'Implement the contract.',
        steps: [{ detail: null, title: null }],
        title: 'Provider compatibility',
      }).success
    ).toBe(false);
    expect(
      validateToolInputValue(
        toolSchemas.NATIVE_TOOL_INPUT_SCHEMAS['brainstrike.inspectCommandSessions'],
        { operation: { action: 'unknown', offset: null } }
      ).success
    ).toBe(false);
  });

  it('registers every schema through exactly one producer', () => {
    // ADR-0004 (amended 2026-10-15): Effect Schema is the boundary owner and
    // the remaining zod tool schemas are being converted behind it. A tool must
    // belong to exactly ONE producer — a schema neither of them made would
    // reach the provider as an unvalidated shape, so this is the guard that
    // nothing is registered raw.
    for (const [toolId, schema] of Object.entries(toolSchemas.NATIVE_TOOL_INPUT_SCHEMAS)) {
      const effect = isEffectToolInputSchema(schema);
      const zod = schema instanceof z.ZodPipe;
      expect([effect, zod].filter(Boolean), toolId).toHaveLength(1);
      expect(toToolInputJsonSchema(schema), toolId).toMatchObject({ type: 'object' });
    }
  });

  it('hands every caller its own copy of an Effect-derived provider schema', () => {
    // The derived document is computed once and handed out by value. A caller
    // that mutated a shared object would silently change what later providers
    // are sent — the per-provider compat layers DO rewrite what they are given.
    const effectSchemas = Object.entries(toolSchemas.NATIVE_TOOL_INPUT_SCHEMAS).filter(
      ([, schema]) => isEffectToolInputSchema(schema)
    );
    expect(effectSchemas.length, 'the converted slice must be registered').toBeGreaterThan(0);
    for (const [toolId, schema] of effectSchemas) {
      const first = toToolInputJsonSchema(schema);
      first['additionalProperties'] = 'mutated';
      expect(toToolInputJsonSchema(schema), toolId).toMatchObject({
        additionalProperties: false,
      });
    }
  });

  it('wraps every registered zod schema without widening its provider JSON Schema', () => {
    for (const [toolId, schema] of Object.entries(toolSchemas.NATIVE_TOOL_INPUT_SCHEMAS)) {
      if (!(schema instanceof z.ZodPipe)) {
        continue;
      }
      const wrappedJsonSchema = z.toJSONSchema(schema, PROVIDER_JSON_SCHEMA_OPTIONS);
      const authoredJsonSchema = z.toJSONSchema(schema.out, PROVIDER_JSON_SCHEMA_OPTIONS);
      expect(wrappedJsonSchema, toolId).toEqual(authoredJsonSchema);
      expect(JSON.stringify(wrappedJsonSchema), toolId).toBe(JSON.stringify(authoredJsonSchema));

      const mastraOptions = { io: 'input', target: 'draft-07' } as const;
      const wrappedMastraSchema = standardSchemaToJSONSchema(
        toStandardSchema(schema),
        mastraOptions
      );
      const authoredMastraSchema = standardSchemaToJSONSchema(
        toStandardSchema(schema.out),
        mastraOptions
      );
      expect(wrappedMastraSchema, toolId).toEqual(authoredMastraSchema);
      expect(JSON.stringify(wrappedMastraSchema), toolId).toBe(
        JSON.stringify(authoredMastraSchema)
      );
    }
  });

  // Zod 4.5 stopped being able to PRODUCE this shape. Through 4.4,
  // `z.intersection(...)` emitted `allOf`; 4.5 merges intersections to match
  // TypeScript (colinhacks/zod#6412) and emits a plain merged object. The
  // rejection branch is still correct and still reachable — a hand-authored or
  // third-party tool schema can carry `allOf` — so the fixture is now the JSON
  // Schema itself rather than something derived from Zod. Deriving it left the
  // branch UNEXERCISED while the test still passed its other case, which is the
  // failure mode worth avoiding here.
  it('rejects an allOf intersection, whatever produced it', () => {
    expect(
      collectUnsupportedProviderSchemaShapes(
        {
          allOf: [
            { properties: { left: { type: 'string' } }, type: 'object' },
            { properties: { right: { type: 'string' } }, type: 'object' },
          ],
          type: 'object',
        },
        'example-0'
      )
    ).toEqual(['example-0 at $.allOf: allOf intersections are unsupported']);
  });

  // Pins the reason the case above no longer derives its fixture from Zod. If a
  // later Zod goes back to emitting `allOf` for intersections, this fails and
  // says so, instead of the comment quietly rotting.
  it('records that the installed Zod merges intersections instead of emitting allOf', () => {
    const intersection = z.toJSONSchema(
      z.intersection(
        z.object({ left: z.string().optional() }),
        z.object({ right: z.string().optional() })
      ),
      PROVIDER_JSON_SCHEMA_OPTIONS
    );
    expect(intersection).not.toHaveProperty('allOf');
    // Assert the merge POSITIVELY too. `not.toHaveProperty('allOf')` alone would
    // also pass if a future Zod expressed the intersection some third way —
    // `$ref`, `unevaluatedProperties` — which would invalidate the comment above
    // just as thoroughly as a return to `allOf`.
    expect(intersection).toMatchObject({
      properties: { left: { type: 'string' }, right: { type: 'string' } },
      type: 'object',
    });
    expect(collectUnsupportedProviderSchemaShapes(intersection, 'merged')).toEqual([]);
  });

  // The bump changes the WIRE, not just the inspector: every `.nullable()` /
  // `.nullish()` field in the catalog now serializes as a JSON Schema type array
  // instead of an `anyOf`. The sweep below would keep passing either way, because
  // nothing in it carried a type-array case — so this pins both halves: that the
  // installed Zod really emits the new spelling for a catalog-shaped field, and
  // that provider normalization accepts it.
  it('accepts the type-array nullable spelling that reaches providers', () => {
    const nullable = z.toJSONSchema(
      z.object({ root: z.string().nullable().describe('open-folder id') }),
      PROVIDER_JSON_SCHEMA_OPTIONS
    );
    expect(nullable.properties?.['root']).toMatchObject({ type: ['string', 'null'] });
    expect(collectUnsupportedProviderSchemaShapes(nullable, 'nullable')).toEqual([]);
  });

  it('rejects unsupported provider-normalization shapes with tool and JSON paths', () => {
    const unsupportedExamples = [
      z.object({
        files: z.record(z.string(), z.object({ note: z.string().optional() }).strict()),
      }),
    ];

    expect(
      unsupportedExamples.flatMap((schema, index) =>
        collectUnsupportedProviderSchemaShapes(
          z.toJSONSchema(schema, PROVIDER_JSON_SCHEMA_OPTIONS),
          `example-${index}`
        )
      )
    ).toEqual([
      'example-0 at $.properties.files.additionalProperties: structured additionalProperties is unsupported',
    ]);

    // Read each tool's model-facing schema through the producer-neutral
    // accessor, so a converted tool is swept on the same terms as a zod one.
    const unsupportedCatalogShapes = Object.entries(toolSchemas.NATIVE_TOOL_INPUT_SCHEMAS).flatMap(
      ([toolId, schema]) =>
        collectUnsupportedProviderSchemaShapes(toToolInputJsonSchema(schema), toolId)
    );

    expect(
      unsupportedCatalogShapes,
      'provider null normalization only supports declared properties, arrays/tuples, and supported unions'
    ).toEqual([]);
  });

  it('normalizes direct factory schemas through Standard Schema without mutating input', async () => {
    const providerInput = {
      options: [{ description: null, label: 'Continue' }],
      question: 'Continue?',
      selectionMode: null,
    };

    const result = await toolSchemas.AskUserInputSchema['~standard'].validate(providerInput);
    expect(result).toEqual({
      value: {
        options: [{ label: 'Continue' }],
        question: 'Continue?',
      },
    });
    expect(providerInput).toEqual({
      options: [{ description: null, label: 'Continue' }],
      question: 'Continue?',
      selectionMode: null,
    });
  });

  it('keeps null values in dynamic records visible to validation', () => {
    const schema = providerCompatibleInputSchema(
      z.object({ headers: z.record(z.string(), z.string()).optional() }).strict()
    );

    expect(schema.safeParse({ headers: { Authorization: null } }).success).toBe(false);
  });

  it('normalizes nullable optional properties to omission', () => {
    const schema = providerCompatibleInputSchema(
      z.object({ note: z.string().nullable().optional() }).strict()
    );

    expect(schema.parse({ note: null })).toEqual({});
  });

  it('normalizes nullable defaulted properties to their default', () => {
    const schema = providerCompatibleInputSchema(
      z.object({ mode: z.enum(['brief', 'full']).nullable().default('brief') }).strict()
    );

    expect(schema.parse({ mode: null })).toEqual({ mode: 'brief' });
  });

  it('normalizes optional scalar-union null to omission', () => {
    const schema = providerCompatibleInputSchema(
      z.object({ selector: z.union([z.string(), z.number()]).optional() }).strict()
    );

    expect(schema.parse({ selector: null })).toEqual({});
  });

  it('normalizes provider nulls through nullable structured wrappers and tuple positions', () => {
    const schema = providerCompatibleInputSchema(
      z
        .object({
          config: z.object({ note: z.string().optional() }).strict().nullable().optional(),
          entries: z
            .array(z.object({ note: z.string().optional() }).strict())
            .nullable()
            .optional(),
          tuple: z.tuple([z.object({ note: z.string().optional() }).strict()]).optional(),
        })
        .strict()
    );

    expect(
      schema.parse({
        config: { note: null },
        entries: [{ note: null }],
        tuple: [{ note: null }],
      })
    ).toEqual({ config: {}, entries: [{}], tuple: [{}] });
  });

  it('keeps ambiguous structured-union nulls visible to authored validation', () => {
    const schema = providerCompatibleInputSchema(
      z
        .object({
          config: z
            .union([
              z.object({ note: z.string().optional() }).strict(),
              z.object({ title: z.string().optional() }).strict(),
            ])
            .optional(),
        })
        .strict()
    );

    expect(schema.safeParse({ config: { note: null } }).success).toBe(false);
  });

  it('normalizes nested ordinary-union optional null through its unique const branch', () => {
    const schema = providerCompatibleInputSchema(
      z
        .object({
          operation: z.union([
            z.object({ action: z.literal('read'), cursor: z.number().optional() }).strict(),
            z.object({ action: z.literal('stop'), sessionId: z.string() }).strict(),
          ]),
        })
        .strict()
    );

    expect(schema.parse({ operation: { action: 'read', cursor: null } })).toEqual({
      operation: { action: 'read' },
    });
  });

  it('runs authored refinements and transforms exactly once', () => {
    let refinementRuns = 0;
    let transformRuns = 0;
    const schema = providerCompatibleInputSchema(
      z
        .object({ note: z.string().nullable().optional() })
        .strict()
        .superRefine(() => {
          refinementRuns += 1;
        })
        .transform((value) => {
          transformRuns += 1;
          return value;
        })
    );

    expect(schema.parse({ note: null })).toEqual({});
    expect(refinementRuns).toBe(1);
    expect(transformRuns).toBe(1);
  });

  it('defers JSON Schema conversion until first parse and memoizes it per wrapper', async () => {
    vi.resetModules();
    const actualZod = await vi.importActual<typeof import('zod')>('zod');
    const toJSONSchema = vi.fn(actualZod.z.toJSONSchema);
    const mockedZ = new Proxy(actualZod.z, {
      get(target, property, receiver) {
        return property === 'toJSONSchema' ? toJSONSchema : Reflect.get(target, property, receiver);
      },
    });
    vi.doMock('zod', () => ({ ...actualZod, z: mockedZ }));

    try {
      const { z: isolatedZ } = await import('zod');
      const { providerCompatibleInputSchema: isolatedProviderCompatibleInputSchema } = await import(
        '../tools/provider-compatible-input'
      );
      const schema = isolatedProviderCompatibleInputSchema(
        isolatedZ.object({ note: isolatedZ.string().optional() }).strict()
      );

      await import('../tools/schemas');
      expect(toJSONSchema).not.toHaveBeenCalled();

      expect(schema.parse({ note: null })).toEqual({});
      expect(toJSONSchema).toHaveBeenCalledTimes(1);

      expect(schema.parse({ note: null })).toEqual({});
      expect(toJSONSchema).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock('zod');
      vi.resetModules();
    }
  });

  it('validates the manageCanvas action union, tolerating cross-action extras (model-idiomatic)', () => {
    const schema = toolSchemas.NATIVE_TOOL_INPUT_SCHEMAS['brainstrike.manageCanvas'];

    expect(
      schema.safeParse({ action: 'create', html: '<p>Hello</p>', title: 'Draft' }).success
    ).toBe(true);
    expect(
      schema.safeParse({
        action: 'update',
        canvasId: 'canvas-1',
        newString: 'new',
        oldString: 'old',
      }).success
    ).toBe(true);
    expect(schema.safeParse({ action: 'rewrite', canvasId: 'canvas-1', html: '' }).success).toBe(
      true
    );
    expect(schema.safeParse({ action: 'list' }).success).toBe(true);

    // Cross-action EXTRAS among the six declared keys are tolerated: `action`
    // fully determines semantics, and real models bundle fields (observed live
    // with gpt-5.6 on 2026-08-07 — both payloads below are verbatim from the
    // production failure). Rejecting them broke the feature and burned retry
    // tokens.
    expect(
      schema.safeParse({
        action: 'create',
        canvasId: 'redundant',
        html: '<h1>Report</h1>',
        newString: 'b',
        oldString: 'a',
        title: 'Report',
      }).success
    ).toBe(true);
    expect(
      schema.safeParse({
        action: 'list',
        canvasId: 'c',
        html: 'x',
        newString: 'n',
        oldString: 'o',
        title: 't',
      }).success
    ).toBe(true);

    // The executor-side normalizer strips tolerated extras down to the clean
    // action-branch shape (no cross-action keys reach the repository).
    expect(
      toolSchemas.normalizeManageCanvasInput({
        action: 'create',
        canvasId: 'redundant',
        html: '<h1>R</h1>',
        newString: 'b',
        oldString: 'a',
        title: 'Report',
      })
    ).toEqual({ action: 'create', html: '<h1>R</h1>', title: 'Report' });

    // Missing REQUIRED fields for the chosen action still fail…
    expect(
      schema.safeParse({ action: 'update', canvasId: 'canvas-1', oldString: 'old' }).success
    ).toBe(false);
    // …as do unknown actions and genuinely unknown keys (hallucinated API —
    // the strict envelope still catches those).
    expect(schema.safeParse({ action: 'unknown' }).success).toBe(false);
    expect(
      schema.safeParse({ action: 'create', content: 'nope', html: '', title: 'x' }).success
    ).toBe(false);
  });

  it('keeps command-session inspection separate from execute-risk management', () => {
    // Both tools are Effect-authored, so the action union is exercised through
    // the producer-neutral accessor. These cases are the guard that the
    // conversion kept `z.discriminatedUnion`'s behaviour: a wrong `action`,
    // an out-of-range bound, a root-level envelope, and a field belonging to
    // another branch all still fail.
    const inspects = (value: unknown) =>
      validateToolInputValue(
        toolSchemas.NATIVE_TOOL_INPUT_SCHEMAS['brainstrike.inspectCommandSessions'],
        value
      ).success;
    const manages = (value: unknown) =>
      validateToolInputValue(
        toolSchemas.NATIVE_TOOL_INPUT_SCHEMAS['brainstrike.manageCommandSession'],
        value
      ).success;

    expect(inspects({ operation: { action: 'list' }, root: 'api' })).toBe(true);
    expect(inspects({ operation: { action: 'list', offset: 25 }, root: 'api' })).toBe(true);
    expect(inspects({ operation: { action: 'list', offset: -1 } })).toBe(false);
    expect(
      inspects({ operation: { action: 'read', cursor: -1, sessionId: 'session-1' }, root: 'api' })
    ).toBe(true);
    expect(inspects({ operation: { action: 'stop', sessionId: 'session-1' } })).toBe(false);
    expect(inspects({ action: 'list', cursor: 0 })).toBe(false);
    expect(inspects({ operation: { action: 'list', sessionId: 'ignored' } })).toBe(false);

    expect(manages({ operation: { action: 'start', command: 'pnpm dev' }, root: 'api' })).toBe(
      true
    );
    expect(manages({ operation: { action: 'write', data: 'q\n', sessionId: 'session-1' } })).toBe(
      true
    );
    expect(manages({ operation: { action: 'stop', sessionId: 'session-1' } })).toBe(true);
    expect(manages({ operation: { action: 'remove', sessionId: 'session-1' } })).toBe(true);
    expect(manages({ operation: { action: 'read', sessionId: 'session-1' } })).toBe(false);
    expect(manages({ operation: { action: 'start', command: 'pnpm dev', data: 'ignored' } })).toBe(
      false
    );
    expect(
      manages({
        operation: { action: 'write', command: 'ignored', data: 'q', sessionId: 'session-1' },
      })
    ).toBe(false);
    expect(manages({ operation: { action: 'stop', cwd: 'ignored', sessionId: 'session-1' } })).toBe(
      false
    );
  });

  it('requires an explicit diagnostics query mode and bounds its filters', () => {
    const schema = toolSchemas.NATIVE_TOOL_INPUT_SCHEMAS['brainstrike.queryDiagnostics'];
    const parse = (value: unknown) => validateToolInputValue(schema, value).success;

    expect(parse({ mode: 'events' })).toBe(true);
    expect(
      parse({
        fingerprint: 'fp-provider',
        limit: 100,
        mode: 'fingerprints',
        severity: 'error',
        since: '2026-07-20T00:00:00.000Z',
        threadId: 'thread-1',
        until: '2026-07-28T00:00:00.000Z',
      })
    ).toBe(true);
    expect(parse({ limit: 201, mode: 'events' })).toBe(false);
    expect(parse({ mode: 'unknown' })).toBe(false);
    expect(parse({})).toBe(false);
    // The ISO bounds are length-bounded, never regex-bounded: a `pattern` would
    // cost prompt tokens and Google's compat layer strips it anyway.
    expect(JSON.stringify(toToolInputJsonSchema(schema))).not.toContain('"pattern"');
  });
});
