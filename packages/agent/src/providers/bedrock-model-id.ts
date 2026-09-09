/**
 * Bedrock cross-region inference-profile prefixing (BST-1350, revised per
 * PR #2522 review findings 2/3).
 *
 * The catalog stores UNPREFIXED Bedrock model ids (e.g.
 * `anthropic.claude-sonnet-5`); specific model/region combinations are
 * invoked through a cross-region inference profile (`us.` / `eu.` / `jp.` /
 * `au.` / `global.` prefix). The tables below are DERIVED FROM models.dev
 * GROUND TRUTH (https://models.dev/api.json, amazon-bedrock provider,
 * retrieved 2026-08-18): a prefix is emitted only when models.dev lists that
 * exact regional profile id. Notable consequences vs the older
 * substring-family table this replaces:
 *
 * - `us.` covers the claude family, `deepseek.r1-v1:0`, and the two llama4
 *   routes — NOT nova and NOT `deepseek.v3.2` (no such profiles exist).
 * - `eu.` is claude-only (no nova/llama3/pixtral profiles today).
 * - `au.`/`jp.` are claude subsets; `anthropic.claude-fable-5` has NO
 *   au./jp./apac. profile and stays unprefixed in those geographies.
 * - `apac.` profiles do not exist at all today, so it is never emitted.
 *
 * When no regional profile exists for a model+region the id is sent
 * VERBATIM and Bedrock itself reports the routing outcome — guessing a
 * profile that may not exist would fail worse. Ids already carrying a
 * cross-region prefix pass through untouched (never double-prefixed).
 *
 * Unlike opencode there is NO default region here: the caller (the bedrock
 * factory case) guarantees a validated region, because a missing region is a
 * typed init failure — never a silent `us-east-1`.
 *
 * Refresh procedure: re-run the models.dev extraction (prefixed keys grouped
 * by prefix), update the sets, update bedrock-model-id.spec.ts, and bump the
 * retrieval date above.
 */

const CROSS_REGION_PREFIXES = ['global.', 'us.', 'eu.', 'jp.', 'apac.', 'au.'] as const;

/**
 * Unprefixed ids with a `us.<id>` profile (models.dev 2026-08-18, plus
 * `anthropic.claude-fable-5-1` re-checked against the same source on
 * 2026-09-08 for BST-1691 — models.dev lists `us.` and `global.` profiles for
 * it and no `eu.`/`jp.`/`au.` ones, so it appears in this set only).
 */
const US_PROFILE_MODEL_IDS: ReadonlySet<string> = new Set([
  'anthropic.claude-fable-5',
  'anthropic.claude-fable-5-1',
  'anthropic.claude-haiku-4-5-20251001-v1:0',
  'anthropic.claude-opus-4-1-20250805-v1:0',
  'anthropic.claude-opus-4-5-20251101-v1:0',
  'anthropic.claude-opus-4-6-v1',
  'anthropic.claude-opus-4-7',
  'anthropic.claude-opus-4-8',
  'anthropic.claude-opus-5',
  'anthropic.claude-sonnet-4-5-20250929-v1:0',
  'anthropic.claude-sonnet-4-6',
  'anthropic.claude-sonnet-5',
  'deepseek.r1-v1:0',
  'meta.llama4-maverick-17b-instruct-v1:0',
  'meta.llama4-scout-17b-instruct-v1:0',
]);

/** Unprefixed ids with an `eu.<id>` profile (models.dev 2026-08-18). */
const EU_PROFILE_MODEL_IDS: ReadonlySet<string> = new Set([
  'anthropic.claude-fable-5',
  'anthropic.claude-haiku-4-5-20251001-v1:0',
  'anthropic.claude-opus-4-5-20251101-v1:0',
  'anthropic.claude-opus-4-6-v1',
  'anthropic.claude-opus-4-7',
  'anthropic.claude-opus-4-8',
  'anthropic.claude-opus-5',
  'anthropic.claude-sonnet-4-5-20250929-v1:0',
  'anthropic.claude-sonnet-4-6',
  'anthropic.claude-sonnet-5',
]);

/** Unprefixed ids with a `jp.<id>` profile (models.dev 2026-08-18). */
const JP_PROFILE_MODEL_IDS: ReadonlySet<string> = new Set([
  'anthropic.claude-haiku-4-5-20251001-v1:0',
  'anthropic.claude-opus-4-7',
  'anthropic.claude-opus-4-8',
  'anthropic.claude-opus-5',
  'anthropic.claude-sonnet-4-5-20250929-v1:0',
  'anthropic.claude-sonnet-4-6',
  'anthropic.claude-sonnet-5',
]);

/** Unprefixed ids with an `au.<id>` profile (models.dev 2026-08-18). */
const AU_PROFILE_MODEL_IDS: ReadonlySet<string> = new Set([
  'anthropic.claude-haiku-4-5-20251001-v1:0',
  'anthropic.claude-opus-4-6-v1',
  'anthropic.claude-opus-4-8',
  'anthropic.claude-opus-5',
  'anthropic.claude-sonnet-4-5-20250929-v1:0',
  'anthropic.claude-sonnet-4-6',
  'anthropic.claude-sonnet-5',
]);

/**
 * Regions the `eu.` profile is emitted from (kept from the opencode table —
 * models.dev does not publish per-region availability, and these are the EU
 * commercial regions Bedrock serves the profile in).
 */
const EU_PREFIX_REGIONS: ReadonlySet<string> = new Set([
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-north-1',
  'eu-central-1',
  'eu-south-1',
  'eu-south-2',
]);

const AU_REGIONS: ReadonlySet<string> = new Set(['ap-southeast-2', 'ap-southeast-4']);

type PrefixGroup = 'au' | 'eu' | 'jp' | 'us';

const PROFILE_MODEL_IDS_BY_GROUP: Record<PrefixGroup, ReadonlySet<string>> = {
  au: AU_PROFILE_MODEL_IDS,
  eu: EU_PROFILE_MODEL_IDS,
  jp: JP_PROFILE_MODEL_IDS,
  us: US_PROFILE_MODEL_IDS,
};

function prefixGroupForRegion(region: string): PrefixGroup | undefined {
  if (region.startsWith('us-') && !region.startsWith('us-gov')) {
    return 'us';
  }
  if (EU_PREFIX_REGIONS.has(region)) {
    return 'eu';
  }
  if (AU_REGIONS.has(region)) {
    return 'au';
  }
  if (region === 'ap-northeast-1') {
    return 'jp';
  }
  // Every other region — including the whole remaining ap-* set — has no
  // cross-region profile group today (no apac. profiles exist on models.dev).
  return;
}

/**
 * Strip a cross-region inference-profile prefix, returning the CATALOG id.
 *
 * Exported for the CAPABILITY lookups (prompt caching, reasoning dialect),
 * which are keyed on the unprefixed catalog id. `createProvider` accepts an
 * already-prefixed id and passes it through (BST-1350 contract, pinned by
 * provider-factory.bedrock.spec.ts), so a routed id genuinely does reach those
 * lookups — and a raw miss would silently cost that route BOTH prompt caching
 * and its reasoning dialect. Resolving the prefix away is the fix; the prefix
 * selects a region, it never changes what the model supports.
 */
export function stripCrossRegionPrefix(modelId: string): string {
  const prefix = CROSS_REGION_PREFIXES.find((candidate) => modelId.startsWith(candidate));
  return prefix ? modelId.slice(prefix.length) : modelId;
}

export function resolveBedrockModelId(modelId: string, region: string): string {
  if (CROSS_REGION_PREFIXES.some((prefix) => modelId.startsWith(prefix))) {
    return modelId;
  }
  const group = prefixGroupForRegion(region);
  if (group && PROFILE_MODEL_IDS_BY_GROUP[group].has(modelId)) {
    return `${group}.${modelId}`;
  }
  return modelId;
}
