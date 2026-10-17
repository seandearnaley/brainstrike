import { JsonSchema, Schema } from 'effect';
import { normalizeProviderNulls } from './provider-null-normalization.js';

/** A decode failure, with the path Standard Schema reports it at. */
export interface EffectToolInputIssue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined;
}

type EffectToolInputResult<Output> =
  | { readonly issues: readonly EffectToolInputIssue[] }
  | { readonly value: Output };

/** The JSON Schema dialects a tool boundary emits; Effect supports these two. */
export type ToolJsonSchemaTarget = 'draft-07' | 'draft-2020-12';

/**
 * The model-facing contract of a tool authored in Effect Schema (ADR-0004,
 * amended 2026-10-15). One value carries both halves of the boundary:
 *
 * - `~standard.jsonSchema` is the JSON Schema the provider receives. The AI
 *   SDK accepts it because `FlexibleSchema` admits a Standard Schema whose
 *   props carry a `StandardJSONSchemaV1.Converter`, and `@mastra/schema-compat`
 *   accepts the same value as a `StandardSchemaWithJSON`. Neither needs to know
 *   which library authored the schema.
 * - `~standard.validate` is the authored validator the host parses tool input
 *   with.
 *
 * Both halves come from one call so their strictness cannot drift; see
 * {@link effectToolInputSchema}.
 */
export interface EffectToolInputSchema<Output> {
  readonly '~standard': {
    readonly jsonSchema: {
      readonly input: (options: { readonly target: string }) => Record<string, unknown>;
      readonly output: (options: { readonly target: string }) => Record<string, unknown>;
    };
    /**
     * Standard Schema's inference phantom: declared so consumers can read the
     * decoded type off the value, NEVER constructed. zod does the same — its
     * runtime `standardProps()` emits only `validate`/`vendor`/`version` and
     * leaves `types` to the type system.
     *
     * The spec declares it optional and its own helpers read it through
     * `NonNullable<…>`, but `@mastra/schema-compat`'s `InferPublicSchema`
     * matches on a REQUIRED `types` (zod reaches an earlier branch via its
     * private `_output`, so it never needed this one). Declaring it optional
     * here made `createTool`'s `execute` see `unknown` for every
     * Effect-authored tool, so it is required.
     */
    readonly types: { readonly input: unknown; readonly output: Output };
    readonly validate: (
      value: unknown
    ) => EffectToolInputResult<Output> | Promise<EffectToolInputResult<Output>>;
    readonly vendor: 'brainstrike';
    readonly version: 1;
  };
}

/**
 * A native tool's object shape is closed: a key the schema does not declare is
 * a model mistake we want named, not dropped. Effect spells that on BOTH sides
 * of the boundary and its own documentation says to pass the pair together —
 * `onExcessProperty: 'error'` makes `toJsonSchemaDocument` emit
 * `additionalProperties: false` (the emitter's default is `true`), and the same
 * option makes the decoder reject the key. Declaring it once here is what keeps
 * the advertised schema and the enforced schema the same object's two views.
 */
const EXCESS_PROPERTY = { onExcessProperty: 'error' } as const;

/**
 * Derive the JSON Schema a provider receives, in the dialect it asked for.
 *
 * `Schema.toStandardJSONSchemaV1` is deliberately NOT used: it takes no
 * options, so it always emits `additionalProperties: true` and would advertise
 * an open object for a tool whose validator rejects unknown keys. Effect emits
 * the dialect on the `Document`, not in the schema, so the root `$schema` is
 * stamped from Effect's own exported constant.
 *
 * An unsupported dialect throws. The caller asked for a contract we cannot
 * express, and answering with a different dialect's document — which is what
 * ignoring the option would do — is the silent kind of wrong that reaches a
 * provider looking plausible. `toDocumentDraft07` likewise throws rather than
 * dropping a keyword it cannot lower.
 */
export function toEffectInputJsonSchema(
  schema: Schema.Constraint,
  target: string,
  options: { readonly onExcessProperty: 'error' | 'ignore' } = EXCESS_PROPERTY
): Record<string, unknown> {
  const document2020 = Schema.toJsonSchemaDocument(schema, options);
  if (target === 'draft-2020-12') {
    return withDefinitions(document2020.schema, document2020.definitions, {
      key: '$defs',
      uri: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
    });
  }
  if (target === 'draft-07') {
    const document07 = JsonSchema.toDocumentDraft07(document2020);
    return withDefinitions(document07.schema, document07.definitions, {
      key: 'definitions',
      uri: JsonSchema.META_SCHEMA_URI_DRAFT_07,
    });
  }
  throw new TypeError(`Unsupported tool JSON Schema target: ${target}`);
}

function withDefinitions(
  schema: JsonSchema.JsonSchema,
  definitions: JsonSchema.Definitions,
  dialect: { readonly key: '$defs' | 'definitions'; readonly uri: string }
): Record<string, unknown> {
  const root: Record<string, unknown> = { $schema: dialect.uri, ...schema };
  // Tool providers retain an explicit property map even for a no-argument object.
  if (root['type'] === 'object' && !Object.hasOwn(root, 'properties')) {
    root['properties'] = {};
  }
  if (Object.keys(definitions).length > 0) {
    root[dialect.key] = definitions;
  }
  return root;
}

/**
 * Admit an Effect Schema as a native tool's input schema.
 *
 * This is the single producer for strict native tool inputs. The shared
 * normalizer drops provider null only from declared optional fields.
 *
 * `Schema.toStandardSchemaV1` annotates the schema it is given and is
 * first-call-wins on `~standard.validate`, so the parse options must be fixed
 * here rather than passed in — a shared sub-schema would otherwise inherit
 * whichever tool was constructed first.
 */
export function effectToolInputSchema<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S
): EffectToolInputSchema<S['Type']> {
  // Derivation walks the whole AST, so each dialect is computed at most once.
  const derived = new Map<string, Record<string, unknown>>();
  const cached = (target: string): Record<string, unknown> => {
    const existing = derived.get(target);
    if (existing) {
      return existing;
    }
    const fresh = toEffectInputJsonSchema(schema, target);
    derived.set(target, fresh);
    return fresh;
  };
  // Callers get a copy: the per-provider compat layers rewrite what they are
  // given, and one of them must not be able to rewrite another's input.
  const view = (options: { readonly target: string }): Record<string, unknown> =>
    structuredClone(cached(options.target));
  const validate = Schema.toStandardSchemaV1(schema, { parseOptions: EXCESS_PROPERTY })['~standard']
    .validate;
  const standard = {
    jsonSchema: { input: view, output: view },
    // The authored schema decides which properties a provider `null` may be
    // dropped from, so normalization reads the dialect the wire uses. It only
    // reads the document, so it takes the cached one rather than a clone per
    // tool call.
    validate: (value: unknown) => validate(normalizeProviderNulls(value, cached('draft-07'))),
    vendor: 'brainstrike',
    version: 1,
  } as const satisfies Omit<EffectToolInputSchema<S['Type']>['~standard'], 'types'>;
  // `types` is the inference phantom documented on the interface: asserted
  // here rather than built, so the real props above stay fully checked.
  return { '~standard': standard as EffectToolInputSchema<S['Type']>['~standard'] };
}

/** Narrow a native tool input schema to the Effect-authored producer's output. */
export function isEffectToolInputSchema(value: unknown): value is EffectToolInputSchema<unknown> {
  if (typeof value !== 'object' || value === null || !('~standard' in value)) {
    return false;
  }
  const standard = (value as EffectToolInputSchema<unknown>)['~standard'];
  return (
    typeof standard === 'object' &&
    standard !== null &&
    standard.vendor === 'brainstrike' &&
    typeof standard.validate === 'function' &&
    typeof standard.jsonSchema?.input === 'function'
  );
}
