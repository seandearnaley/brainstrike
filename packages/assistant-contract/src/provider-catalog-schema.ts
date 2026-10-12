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
 * 1. Every object is a `strictObject`. A misspelled optional key (`taglin`,
 *    `visoin`) used to be an excess-property compile error; without `strict`
 *    it would now be silently dropped, which is exactly the silent
 *    degradation the repo forbids. `_note` is the one non-runtime key and it
 *    is declared explicitly rather than tolerated.
 *
 * 2. The literal unions below are hand-mirrored from the TypeScript types in
 *    `provider-registry.ts` — but they cannot drift undetected.
 *    `provider-catalog-schema.test.ts` asserts MUTUAL assignability between
 *    `CatalogShape<z.infer<…>>` and the corresponding interface, so adding a
 *    union member on one side and not the other is a type-check failure, not
 *    a runtime surprise.
 */

import { OPENAI_REASONING_EFFORT_VALUES } from '@brainstrike/types';
import { z } from 'zod';

/**
 * The transformation from "what Zod infers" to "what the registry publishes".
 * Two differences, both deliberate:
 *
 * - `_note` is FILE documentation, not catalog data. It replaces the source
 *   comments the JSON format cannot hold and is dropped before any consumer
 *   sees a definition, so exhaustive `toEqual` assertions on model rows keep
 *   describing the real contract.
 * - Zod 4 has no exact-optional object builder (`z.interface` did not ship in
 *   4.x), so `z.infer` widens every optional key to `T | undefined`, which
 *   this repo's `exactOptionalPropertyTypes: true` refuses. `.parse()` never
 *   ADDS an absent optional key to its output, so the runtime value already
 *   satisfies the exact-optional contract.
 *
 * The `as` key remap keeps the mapped type homomorphic, so optional and
 * readonly modifiers survive.
 */
export type CatalogShape<T> = T extends readonly (infer Element)[]
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
const NoteSchema = z.string();

const AnthropicEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const OpenAiReasoningEffortSchema = z.enum(OPENAI_REASONING_EFFORT_VALUES);
const ModelModalitySchema = z.enum(['audio', 'image', 'text', 'video']);
const ModelVisionSupportSchema = z.enum(['supported', 'unsupported', 'unknown']);
const TokenizerEncodingSchema = z.enum(['o200k_base']);

const TokenizerBackedMeasurementSchema = z.strictObject({
  mode: z.enum(['exact-selected-model', 'declared-compatible-reference']),
  tokenizer: TokenizerEncodingSchema,
});

const LlmModelSchema = z.strictObject({
  _note: NoteSchema.optional(),
  anthropicReasoning: z
    .strictObject({
      defaultEffort: AnthropicEffortSchema,
      // Whether the vendor leaves thinking no off state (BST-1706).
      // Required when the ladder is declared so every row answers it.
      mandatory: z.boolean(),
      supportedEfforts: z.array(AnthropicEffortSchema),
    })
    .optional(),
  bedrockReasoning: z.enum(['adaptive', 'budget-tokens', 'max-reasoning-effort']).optional(),
  contextWindow: z.number(),
  default: z.boolean().optional(),
  id: z.string(),
  inputModalities: z.array(ModelModalitySchema).optional(),
  label: z.string().optional(),
  maxOutputTokens: z.number().optional(),
  nativeToolSearch: z.enum(['anthropic', 'openai']).optional(),
  outputModalities: z.array(ModelModalitySchema).optional(),
  pricing: z
    .strictObject({
      cacheReadPerMTok: z.number().optional(),
      cacheWritePerMTok: z.number().optional(),
      inputPerMTok: z.number(),
      // Gateway long-context surcharge bands (BST-1708): the upstream
      // `pricing.overrides` entries keyed by `min_prompt_tokens`, recorded
      // per-MTok like the base rates. Time-of-day bands are not modelled.
      longContextTiers: z
        .array(
          z.strictObject({
            cacheReadPerMTok: z.number().optional(),
            cacheWritePerMTok: z.number().optional(),
            inputPerMTok: z.number(),
            minPromptTokens: z.number().int().positive(),
            outputPerMTok: z.number(),
          })
        )
        .optional(),
      outputPerMTok: z.number(),
    })
    .optional(),
  promptCaching: z.enum(['anthropic', 'bedrock']).optional(),
  reasoning: z
    .strictObject({
      autoEffort: OpenAiReasoningEffortSchema.optional(),
      defaultEffort: OpenAiReasoningEffortSchema.optional(),
      defaultEnabled: z.boolean().optional(),
      mandatory: z.boolean(),
      supportedEfforts: z.array(OpenAiReasoningEffortSchema),
      vendorDefaultOutputTokens: z.number().optional(),
    })
    .optional(),
  supportsStreaming: z.boolean().optional(),
  tagline: z.string().optional(),
  tokenMeasurement: TokenizerBackedMeasurementSchema.optional(),
  type: z.literal('llm'),
  vision: ModelVisionSupportSchema,
});

const EmbeddingModelSchema = z.strictObject({
  _note: NoteSchema.optional(),
  availableDimensions: z.array(z.number()).optional(),
  default: z.boolean().optional(),
  defaultDimension: z.number(),
  dimensionParameter: z
    .enum(['dimensions', 'output_dimensionality', 'output_dimension'])
    .optional(),
  executionNotes: z
    .strictObject({ wasm: z.string().min(1).optional(), webgpu: z.string().min(1).optional() })
    .optional(),
  id: z.string(),
  label: z.string().optional(),
  recommendedExecution: z
    .strictObject({
      device: z.enum(['webgpu', 'wasm']),
      dtype: z.enum(['fp16', 'fp32', 'q4', 'q8']),
      reason: z.string().min(1),
    })
    .optional(),
  supportsCustomDimensions: z.boolean().optional(),
  supportsStandardDimension: z.boolean(),
  type: z.literal('embedding'),
});

const ProviderModelSchema = z.discriminatedUnion('type', [LlmModelSchema, EmbeddingModelSchema]);

const ProviderSchema = z.strictObject({
  _note: NoteSchema.optional(),
  authType: z.enum(['api_key', 'oauth_subscription', 'aws', 'none']),
  capabilities: z.strictObject({
    embeddings: z.boolean(),
    llm: z.boolean(),
    streaming: z.boolean(),
  }),
  deprecatedEnvKeys: z.array(z.string()).optional(),
  displayName: z.string(),
  docsUrl: z.string().optional(),
  envKeys: z.array(z.string()).optional(),
  id: z.enum([
    'openai',
    'anthropic',
    'google',
    'openrouter',
    'cohere',
    'voyage',
    'bedrock',
    'openai-codex',
    'local',
    'ollama',
    'lmstudio',
  ]),
  keyFormatHint: z.string().optional(),
  keyNotes: z.string().optional(),
  models: z.array(ProviderModelSchema),
  runtime: z.enum(['hosted', 'gateway', 'local', 'browser']),
});

export const ProviderCatalogSchema = z.array(ProviderSchema);

export type ParsedProvider = CatalogShape<z.infer<typeof ProviderSchema>>;
export type ParsedLlmModel = CatalogShape<z.infer<typeof LlmModelSchema>>;
export type ParsedEmbeddingModel = CatalogShape<z.infer<typeof EmbeddingModelSchema>>;

type RawProvider = z.infer<typeof ProviderSchema>;
type RawModel = z.infer<typeof ProviderModelSchema>;

/**
 * Drop the file-level provenance so no consumer ever sees `_note` on a
 * definition. Done here rather than in a Zod `.transform()` because
 * `z.discriminatedUnion` needs plain object schemas for its member lookup.
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
  stripped['models'] = provider.models.map((model: RawModel) => withoutNote(model));
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
function describeIssuePath(path: readonly PropertyKey[], catalog: unknown): string {
  const segments: string[] = [];
  let cursor: unknown = catalog;
  for (const key of path) {
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
  const result = ProviderCatalogSchema.safeParse(catalog);
  if (result.success) {
    return result.data.map(stripNotes);
  }

  const details = result.error.issues
    .map((issue) => `  - ${describeIssuePath(issue.path, catalog)}: ${issue.message}`)
    .join('\n');
  throw new Error(
    `provider-catalog.json is malformed and the model catalog cannot be served partially:\n${details}`,
    { cause: result.error }
  );
}
