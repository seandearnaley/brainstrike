/**
 * Runtime schema for `provider-catalog.json` (BST-1650).
 *
 * The provider/model catalog used to be a 1,600-line TypeScript literal inside
 * `provider-registry.ts`, where `tsc` checked every row. It is now a JSON data
 * file, and `resolveJsonModule` widens JSON literals (`"llm"` becomes
 * `string`), so TypeScript can no longer check the rows. THIS SCHEMA IS THAT
 * CHECK. It runs once, at module load, and throws — a malformed catalog must
 * never degrade into a partial one (repo rule: NO SILENT FALLBACKS).
 *
 * Two properties are load-bearing and deliberate:
 *
 * 1. Every object decodes with strict excess-property checks. A misspelled optional key (`taglin`,
 *    `visoin`) used to be an excess-property compile error; without `strict`
 *    it would now be silently dropped, which is exactly the silent
 *    degradation the repo forbids. `_note` is the one non-runtime key and it
 *    is declared explicitly rather than tolerated.
 *
 * 2. The literal unions below are hand-mirrored from the TypeScript types in
 *    `provider-registry.ts` — but they cannot drift undetected.
 *    `provider-catalog-schema.test.ts` asserts MUTUAL assignability between
 *    `CatalogShape<typeof schema.Type>` and the corresponding interface, so adding a
 *    union member on one side and not the other is a type-check failure, not
 *    a runtime surprise.
 */
import { OPENAI_REASONING_EFFORT_VALUES } from '@brainstrike/types';
import { Schema, SchemaIssue } from 'effect';
import { MODEL_VENDOR_IDS } from './model-vendors.ts';

/**
 * The transformation from "what Effect Schema infers" to "what the registry publishes".
 * Two differences, both deliberate:
 *
 * - `_note` is FILE documentation, not catalog data. It replaces the source
 *   comments the JSON format cannot hold and is dropped before any consumer
 *   sees a definition, so exhaustive `toEqual` assertions on model rows keep
 *   describing the real contract.
 * - Effect Schema's optional fields include explicit undefined; CatalogShape
 *   compares them with the catalog interfaces under exactOptionalPropertyTypes.
 */
type CatalogShape<T> = T extends readonly (infer Element)[]
  ? readonly CatalogShape<Element>[]
  : T extends object
    ? {
        [Key in keyof T as Key extends '_note' ? never : Key]: CatalogShape<
          Exclude<T[Key], undefined>
        >;
      }
    : T;
/**
 * Provenance carried over from the TypeScript comments the JSON file cannot
 * hold: vendor citations, retrieval dates and settled rulings. Never reaches
 * runtime — it exists so a reviewer sees WHY a row says what it says.
 */
const NoteSchema = Schema.String;
const AnthropicEffortSchema = Schema.Literals(['low', 'medium', 'high', 'xhigh', 'max']);
const OpenAiReasoningEffortSchema = Schema.Literals(OPENAI_REASONING_EFFORT_VALUES);
const ModelModalitySchema = Schema.Literals(['audio', 'image', 'pdf', 'text', 'video']);
/** A route's modalities: at least one, each named once. */
const ModalitiesSchema = Schema.mutable(Schema.Array(ModelModalitySchema)).check(
  Schema.makeFilter((modalities) => {
    if (modalities.length === 0) {
      return 'must name at least one modality';
    }
    return new Set(modalities).size === modalities.length
      ? undefined
      : 'must name each modality once';
  })
);
const TokenizerEncodingSchema = Schema.Literals(['o200k_base']);
const TokenizerBackedMeasurementSchema = Schema.Struct({
  mode: Schema.Literals(['exact-selected-model', 'declared-compatible-reference']),
  tokenizer: TokenizerEncodingSchema,
});
const ProviderCatalogPresentationSchema = Schema.Struct({
  enabled: Schema.Boolean,
  icon: Schema.NullOr(Schema.String),
  name: Schema.String.check(Schema.isMinCodePoints(1)),
  sortOrder: Schema.Int,
});
const ModelCatalogPresentationSchema = Schema.Struct({
  ...ProviderCatalogPresentationSchema.fields,
  ...{
    bestFor: Schema.NullOr(Schema.mutable(Schema.Array(Schema.String))),
    description: Schema.NullOr(Schema.String),
    parameters: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
    tagline: Schema.NullOr(Schema.String),
  },
});
/** A token limit: a whole, positive number of tokens. */
const TokenLimitSchema = Schema.Int.check(Schema.isGreaterThan(0));
/**
 * A USD rate per 1M tokens. Zero is allowed for a reviewed free route
 * (`LlmModelDefinition.pricing`); a negative or non-finite rate never is.
 */
const UsdPerMTokSchema = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const LongContextTierSchema = Schema.Struct({
  cacheReadPerMTok: Schema.optional(UsdPerMTokSchema),
  cacheWritePerMTok: Schema.optional(UsdPerMTokSchema),
  inputPerMTok: UsdPerMTokSchema,
  minPromptTokens: TokenLimitSchema,
  outputPerMTok: UsdPerMTokSchema,
});
const PricingRatesFields = {
  cacheReadPerMTok: Schema.optional(UsdPerMTokSchema),
  cacheWritePerMTok: Schema.optional(UsdPerMTokSchema),
  inputPerMTok: UsdPerMTokSchema,
  longContextTiers: Schema.optional(Schema.mutable(Schema.Array(LongContextTierSchema))),
  outputPerMTok: UsdPerMTokSchema,
};
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/u;
function isCalendarDay(value: string): boolean {
  if (!CALENDAR_DAY.test(value)) {
    return false;
  }
  // Date rolls an impossible day over (2026-02-30 reads as 2026-03-02), so the
  // day must survive the round trip unchanged.
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(value);
}
/** A real calendar day, `YYYY-MM-DD`, read as 00:00 UTC. */
const CalendarDaySchema = Schema.String.check(
  Schema.makeFilter((value) =>
    isCalendarDay(value) ? undefined : 'must be a calendar day written YYYY-MM-DD'
  )
);
/** A knowledge cutoff as the vendor states it: a month (`YYYY-MM`) or a day (`YYYY-MM-DD`). */
const KnowledgeCutoffSchema = Schema.String.check(
  Schema.makeFilter((value) =>
    isCalendarDay(value.length === 7 ? `${value}-01` : value)
      ? undefined
      : 'must be a month written YYYY-MM or a calendar day written YYYY-MM-DD'
  )
);
/** Where a row's facts were read, and on which day. */
const ModelSourceSchema = Schema.Struct({
  retrievedAt: CalendarDaySchema,
  url: Schema.String.check(
    Schema.makeFilter((value) =>
      value.startsWith('https://') ? undefined : 'must be an https URL'
    )
  ),
});
/** A whole new rate set a vendor has announced, in force from `effectiveFrom`. */
const PricingChangeSchema = Schema.Struct({
  ...PricingRatesFields,
  effectiveFrom: CalendarDaySchema,
});
/**
 * Where a model stands with its vendor. `legacy` and `deprecated` are what the
 * Model Catalog calls Archived; retirement is not a status (the row is removed
 * and its id remapped).
 */
const ModelLifecycleSchema = Schema.Struct({
  deprecatedAt: Schema.optional(CalendarDaySchema),
  releasedAt: Schema.optional(CalendarDaySchema),
  replacedBy: Schema.optional(Schema.String),
  retiresAt: Schema.optional(CalendarDaySchema),
  status: Schema.Literals(['active', 'deprecated', 'legacy', 'preview']),
});
const LlmModelSchema = Schema.Struct({
  _note: Schema.optional(NoteSchema),
  anthropicReasoning: Schema.optional(
    Schema.Struct({
      defaultEffort: AnthropicEffortSchema,
      mandatory: Schema.Boolean,
      supportedEfforts: Schema.mutable(Schema.Array(AnthropicEffortSchema)),
    })
  ),
  bedrockReasoning: Schema.optional(
    Schema.Literals(['adaptive', 'budget-tokens', 'max-reasoning-effort'])
  ),
  bedrockReasoningMandatory: Schema.optional(Schema.Literal(true)),
  catalog: Schema.optional(ModelCatalogPresentationSchema),
  contextWindow: TokenLimitSchema,
  default: Schema.optional(Schema.Boolean),
  id: Schema.String,
  inputModalities: ModalitiesSchema,
  knowledgeCutoff: Schema.optional(KnowledgeCutoffSchema),
  label: Schema.optional(Schema.String),
  lifecycle: Schema.optional(ModelLifecycleSchema),
  maxOutputTokens: TokenLimitSchema,
  nativeToolSearch: Schema.optional(Schema.Literals(['anthropic', 'openai'])),
  outputModalities: ModalitiesSchema,
  pricing: Schema.optional(
    Schema.Struct({
      ...PricingRatesFields,
      changes: Schema.optional(Schema.mutable(Schema.Array(PricingChangeSchema))),
    })
  ),
  promptCaching: Schema.optional(
    Schema.Literals(['anthropic', 'bedrock', 'openrouter', 'openrouter-breakpoints'])
  ),
  reasoning: Schema.optional(
    Schema.Struct({
      autoEffort: Schema.optional(OpenAiReasoningEffortSchema),
      defaultEffort: Schema.optional(OpenAiReasoningEffortSchema),
      defaultEnabled: Schema.optional(Schema.Boolean),
      mandatory: Schema.Boolean,
      supportedEfforts: Schema.mutable(Schema.Array(OpenAiReasoningEffortSchema)),
      vendorDefaultOutputTokens: Schema.optional(TokenLimitSchema),
    })
  ),
  sources: Schema.mutable(Schema.Array(ModelSourceSchema)).check(Schema.isMinLength(1)),
  structuredOutputs: Schema.optional(Schema.Boolean),
  supportsStreaming: Schema.optional(Schema.Boolean),
  tagline: Schema.optional(Schema.String),
  tokenMeasurement: Schema.optional(TokenizerBackedMeasurementSchema),
  toolCalling: Schema.optional(Schema.Boolean),
  type: Schema.Literal('llm'),
  vendor: Schema.Literals(MODEL_VENDOR_IDS),
});
const ProviderModelSchema = LlmModelSchema;
const ProviderSchema = Schema.Struct({
  _note: Schema.optional(NoteSchema),
  authType: Schema.Literals(['api_key', 'aws', 'chatgpt_sign_in']),
  billsCutOffStreams: Schema.optional(Schema.Boolean),
  capabilities: Schema.Struct({
    streaming: Schema.Boolean,
  }),
  catalog: Schema.optional(ProviderCatalogPresentationSchema),
  deprecatedEnvKeys: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  displayName: Schema.String,
  docsUrl: Schema.optional(Schema.String),
  envKeys: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  id: Schema.Literals(['openai', 'anthropic', 'google', 'openrouter', 'bedrock', 'chatgpt']),
  keyFormatHint: Schema.optional(Schema.String),
  keyNotes: Schema.optional(Schema.String),
  models: Schema.mutable(Schema.Array(ProviderModelSchema)),
  nativeWebSearchUsdPerCall: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0))),
  runtime: Schema.Literals(['hosted', 'gateway']),
});
export const ProviderCatalogSchema = Schema.mutable(Schema.Array(ProviderSchema));
type RawProvider = (typeof ProviderSchema)['Type'];
type RawModel = (typeof ProviderModelSchema)['Type'];
/**
 * A parsed model row: the file's facts plus `vision`, which the catalog never
 * declares. It is read off `inputModalities`, so image support has one writer.
 */
type ParsedModel = CatalogShape<RawModel> & { readonly vision: 'supported' | 'unsupported' };
export type ParsedProvider = Omit<CatalogShape<RawProvider>, 'models'> & {
  readonly models: readonly ParsedModel[];
};
/**
 * Drop the file-level provenance so no consumer ever sees `_note` on a
 * definition, and add the `vision` each row's `inputModalities` implies. The
 * wire grammar validates the file before this projection publishes its
 * runtime definitions.
 *
 * The rebuild goes through `Object.fromEntries` rather than a rest spread so
 * every remaining key keeps its declared position — the parsed definitions
 * enumerate exactly as the data file reads. The one assertion below is where
 * the static `CatalogShape` gap is bridged; it cannot hide a real divergence
 * because `provider-catalog-schema.test.ts` proves both directions of the
 * `CatalogShape`/interface equivalence at type-check time.
 */
function withoutNote(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== '_note'));
}
function stripNotes(provider: RawProvider): ParsedProvider {
  const stripped = withoutNote(provider);
  // Assigning an EXISTING key keeps its position, so the parsed definitions
  // enumerate in exactly the order the data file declares them.
  stripped['models'] = provider.models.map((model: RawModel) => ({
    ...withoutNote(model),
    vision: model.inputModalities.includes('image') ? 'supported' : 'unsupported',
  }));
  return stripped as ParsedProvider;
}
function readStringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return;
  }
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'string' ? candidate : undefined;
}
function readIndex(value: unknown, index: number): unknown {
  return Array.isArray(value) ? value[index] : undefined;
}
/**
 * Zod reports array positions as numbers (`[1, "models", 1, "vision"]`), which
 * makes a reviewer count rows in a 1,800-line data file to find the offending
 * entry. Resolve each array index back to the `id` it carries so the failure
 * names `anthropic/claude-opus-5` instead of `1/1`.
 */
function describeIssuePath(
  path: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined,
  catalog: unknown
): string {
  const segments: string[] = [];
  let cursor: unknown = catalog;
  for (const segment of path ?? []) {
    const key = typeof segment === 'object' ? segment.key : segment;
    if (typeof key === 'number') {
      const entry = readIndex(cursor, key);
      segments.push(readStringProperty(entry, 'id') ?? `[${key}]`);
      cursor = entry;
      continue;
    }
    segments.push(String(key));
    cursor =
      typeof cursor === 'object' && cursor !== null
        ? (cursor as Record<PropertyKey, unknown>)[key]
        : undefined;
  }
  return segments.join('.');
}
/**
 * Parse the catalog or THROW. There is no partial-catalog mode: a model row
 * the schema rejects would otherwise reach the composer, the context meter and
 * the DB catalog contract as a half-populated entry.
 */
export function parseProviderCatalog(catalog: unknown): readonly ParsedProvider[] {
  const result = Schema.decodeUnknownResult(ProviderCatalogSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(catalog);
  if (result._tag === 'Success') {
    return result.success.map(stripNotes);
  }
  const details = SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue)
    .issues.map((issue) => `  - ${describeIssuePath(issue.path, catalog)}: ${issue.message}`)
    .join('\n');
  throw new Error(
    `provider-catalog.json is malformed and the model catalog cannot be served partially:\n${details}`,
    { cause: result.failure }
  );
}
