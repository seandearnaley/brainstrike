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
 * AWS-CARD OVERRIDE (BST-1694, PR #3080 review; audit completed in BST-1710):
 * where an AWS model card enumerates a model's inference profiles, the CARD
 * outranks models.dev. models.dev is a third-party mirror: it can list a
 * profile AWS never published, and it can equally MISS one AWS does publish.
 * Emitting a profile AWS does not publish fails harder than sending the id
 * verbatim — it can only ever be a client-manufactured error, aimed at an id
 * Bedrock will never answer.
 *
 * BST-1710 audited every `jp.` entry against its own card (retrieved
 * 2026-09-10):
 * - PUBLISHED, kept — `anthropic.claude-opus-4-7`,
 *   `anthropic.claude-opus-4-8`, `anthropic.claude-sonnet-4-5-20250929-v1:0`,
 *   `anthropic.claude-sonnet-4-6`, `anthropic.claude-haiku-4-5-20251001-v1:0`.
 *   Each card's Programmatic Access row lists a `jp.<id>` Geo inference ID and
 *   carries a "Geo: JP" section sourced from ap-northeast-1.
 * - PHANTOM, removed — `anthropic.claude-sonnet-5`. Its card
 *   (docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5.html)
 *   gives Geo ids `us.`, `eu.`, `au.` and Global `global.anthropic.claude-sonnet-5`
 *   only, has no "Geo: JP" section, and marks ap-northeast-1 In-Region ✗ /
 *   Geo ✗ / Global ✓.
 * - PHANTOM, removed earlier by BST-1694 on the same evidence shape —
 *   `anthropic.claude-opus-5`.
 *
 * The audit cuts BOTH ways. The same pass found `anthropic.claude-opus-4-7`
 * MISSING from the au. set although its card publishes
 * `au.anthropic.claude-opus-4-7` and marks ap-southeast-2/-4 Geo ✓ while
 * marking the bare id In-Region ✗ everywhere — so Sydney/Melbourne were being
 * handed an id Bedrock cannot invoke. It was added. The us./eu. sets matched
 * their cards for all six audited ids.
 *
 * `anthropic.claude-opus-5-5` (BST-1804) was classified from its own card
 * alone, retrieved 2026-09-22
 * (docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-5-5.html):
 * Programmatic Access lists Geo ids `us.`, `eu.`, `au.` AND `jp.` plus
 * `global.`, and its bedrock-runtime Regional Availability table matches the
 * Opus 4.7 / 4.8 shape exactly (Geo ✗ / Global ✓ only in the core set plus
 * ap-southeast-6; GovCloud Geo ✓ / Global ✗).
 *
 * Cards NOT read in that pass keep their models.dev-derived membership
 * unchanged: fable-5, fable-5-1, opus-4-1, opus-4-5, opus-4-6-v1,
 * deepseek.r1 and the llama4 pair. None of them is in the jp. set, so none can
 * be a jp. phantom.
 *
 * GLOBAL PROFILE ROUTING (BST-1711) — the gap BST-1710 left open. The current
 * Claude cards mark the BASE model id In-Region ✗ in every region, so the bare
 * `anthropic.claude-opus-5` is not invocable at `bedrock-runtime` anywhere — a
 * geo or a global profile is mandatory, and AWS's own sample code on those
 * cards calls `global.<id>`. This module previously emitted no `global.`
 * prefix at all (it appeared only in CROSS_REGION_PREFIXES, for pass-through),
 * so every region a card marks Geo ✗ / Global ✓ received an id Bedrock cannot
 * answer. The two ap-northeast-1 rows the jp. audit had to leave verbatim —
 * opus-5 and sonnet-5 — now take `global.<id>`, which is exactly what their
 * cards publish for Tokyo.
 *
 * PRECEDENCE: geo first, global second, verbatim last. Data residency is the
 * stronger guarantee, so a region that HAS a geo profile for the model keeps
 * getting the geo one; `global.` is emitted only where the card marks the
 * region Geo ✗ / Global ✓. That ordering also means this change can only ever
 * REPLACE an uninvocable verbatim id — it never downgrades an existing geo
 * route to worldwide routing.
 *
 * GOVCLOUD: `us-gov-west-1` / `us-gov-east-1` are marked Global ✗ on every
 * card that lists them (Opus 5, Fable 5.1, Sonnet 4.5), so they appear in NO
 * global set below and can never receive `global.`. They are additionally
 * excluded from the `us.` group by prefixGroupForRegion, unchanged.
 *
 * The global table is per MODEL, not per region prefix: card region tables
 * genuinely disagree with one another (Opus 4.5 has no AU geo at all, so
 * Sydney is global-only for it while every other Claude routes `au.` there;
 * Fable 5/5.1 have no EU geo, so all eight EU regions are global-only for
 * them). Sourced from each card's Regional Availability table, retrieved
 * 2026-09-10 — never from models.dev, per the card-outranks-mirror ruling.
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
 * KNOWN GAPS, deliberately NOT closed here (see the BST-1711 follow-up):
 * - The GEO region map is still prefix-shaped, so regions the cards mark
 *   Geo ✓ but this module does not map keep sending the verbatim id:
 *   `ca-central-1`/`ca-west-1` (US geo), `eu-central-2` (EU geo),
 *   `ap-northeast-3` (JP geo), `ap-southeast-6` (AU geo). Those are
 *   UNDER-emissions, not wrong emissions, and fixing them means replacing
 *   EU_PREFIX_REGIONS/AU_REGIONS with per-model geo tables.
 * - `anthropic.claude-fable-5` is in EU_PROFILE_MODEL_IDS but its card
 *   publishes `us.` and `global.` ONLY — a BST-1710-class models.dev phantom
 *   found while building this table. Same defect class as BST-1710, so it is
 *   filed separately rather than smuggled into a routing PR. Two consequences
 *   are pinned by spec cases so closing the phantom has to change them
 *   deliberately: geo precedence still emits `eu.anthropic.claude-fable-5` in
 *   the SEVEN mapped EU regions, shadowing this model's global entries for
 *   them (the only shadowed pairs that exist — the spec enumerates the whole
 *   global table and fails on any unlisted one); and because EU_PREFIX_REGIONS
 *   omits `eu-central-2` while EU_COMMERCIAL_REGIONS includes it, fable-5
 *   splits INSIDE the EU — `eu.` in eu-west-1, `global.` in eu-central-2.
 *
 * Refresh procedure: re-run the models.dev extraction (prefixed keys grouped
 * by prefix), then CHECK EVERY ID YOU ADD OR KEEP against its AWS model card's
 * Programmatic Access row — the card wins in both directions, and a mirror
 * diff alone has twice now been wrong. Re-transcribe the card's Regional
 * Availability rows for the global table too. Update the sets, update
 * bedrock-model-id.spec.ts, and bump the retrieval dates above.
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
  'anthropic.claude-opus-5-5',
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
  'anthropic.claude-opus-5-5',
  'anthropic.claude-sonnet-4-5-20250929-v1:0',
  'anthropic.claude-sonnet-4-6',
  'anthropic.claude-sonnet-5',
]);

/**
 * Unprefixed ids with a `jp.<id>` profile. Every member was confirmed against
 * its own AWS model card: `anthropic.claude-opus-5-5` from its card retrieved
 * 2026-09-22 (BST-1804), the rest in the BST-1710 audit (2026-09-10). The ids
 * the cards contradict are gone — see the AWS-card override note above.
 */
const JP_PROFILE_MODEL_IDS: ReadonlySet<string> = new Set([
  'anthropic.claude-haiku-4-5-20251001-v1:0',
  'anthropic.claude-opus-4-7',
  'anthropic.claude-opus-4-8',
  'anthropic.claude-opus-5-5',
  'anthropic.claude-sonnet-4-5-20250929-v1:0',
  'anthropic.claude-sonnet-4-6',
]);

/**
 * Unprefixed ids with an `au.<id>` profile (models.dev 2026-08-18, plus
 * `anthropic.claude-opus-4-7` added by the BST-1710 card audit — its card
 * publishes `au.anthropic.claude-opus-4-7` and models.dev had missed it).
 */
const AU_PROFILE_MODEL_IDS: ReadonlySet<string> = new Set([
  'anthropic.claude-haiku-4-5-20251001-v1:0',
  'anthropic.claude-opus-4-6-v1',
  'anthropic.claude-opus-4-7',
  'anthropic.claude-opus-4-8',
  'anthropic.claude-opus-5',
  'anthropic.claude-opus-5-5',
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

/**
 * Regions EVERY global-capable Claude card marks Geo ✗ / Global ✓ (cards
 * retrieved 2026-09-10). Note `us-gov-*` is deliberately absent: the cards
 * that list GovCloud mark it Global ✗.
 *
 * `ap-east-1` (Hong Kong) is absent for a different reason, recorded here so
 * the next transcriber does not re-derive it (PR #3118 review finding 7): it
 * appears NOWHERE on the cards' Regional Availability tables — not as Geo ✗,
 * not as Global ✓, not at all (verified on the Opus 5 card, whose table runs
 * `ap-east-2` straight to `ap-northeast-1`). An absent row is not a Global ✓
 * row, so Hong Kong keeps sending the verbatim id.
 */
const GLOBAL_ONLY_CORE_REGIONS = [
  'af-south-1',
  'ap-east-2',
  'ap-northeast-2',
  'ap-south-1',
  'ap-south-2',
  'ap-southeast-1',
  'ap-southeast-3',
  'ap-southeast-5',
  'ap-southeast-7',
  'il-central-1',
  'me-central-1',
  'me-south-1',
  'mx-central-1',
  'sa-east-1',
] as const;

/** The eight EU commercial regions the cards enumerate. */
const EU_COMMERCIAL_REGIONS = [
  'eu-central-1',
  'eu-central-2',
  'eu-north-1',
  'eu-south-1',
  'eu-south-2',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
] as const;

/** The core Geo ✗ / Global ✓ set plus this model's card-specific additions. */
function globalOnlyRegions(...additional: readonly string[]): ReadonlySet<string> {
  return new Set<string>([...GLOBAL_ONLY_CORE_REGIONS, ...additional]);
}

/*
 * Cards that agree share ONE set, so a refresh cannot silently drift the two
 * halves apart (PR #3118 review finding 5). Splitting a shared const is the
 * forcing function when a future card revision makes the pair disagree.
 */

/** Fable 5 / 5.1: `us.` and `global.` only — no EU, no AU, no JP geo at all. */
const FABLE_GLOBAL_REGIONS = globalOnlyRegions(
  ...EU_COMMERCIAL_REGIONS,
  'ap-northeast-1',
  'ap-northeast-3',
  'ap-southeast-2',
  'ap-southeast-4',
  'ap-southeast-6'
);

/** Haiku 4.5 / Sonnet 4.5: `ca-west-1` is Geo ✗ on both (Geo ✓ elsewhere). */
const CA_WEST_GLOBAL_REGIONS = globalOnlyRegions('ca-west-1');

/** Opus 4.7 / 4.8 / 5.5: US+EU+AU+JP geo — only NZ falls through to global. */
const NZ_ONLY_GLOBAL_REGIONS = globalOnlyRegions('ap-southeast-6');

/** Opus 5 / Sonnet 5: no JP geo, so Tokyo and Osaka join NZ on global. */
const NO_JP_GEO_GLOBAL_REGIONS = globalOnlyRegions(
  'ap-northeast-1',
  'ap-northeast-3',
  'ap-southeast-6'
);

/**
 * Per-model regions where the card marks Geo ✗ / Global ✓ — i.e. where
 * `global.<id>` is the only invocable route and the verbatim id is not.
 * Transcribed from each model card's Regional Availability table (bedrock-
 * runtime), retrieved 2026-09-10.
 *
 * A model ABSENT from this map never receives `global.`, and that absence is
 * a DECISION rather than a default: every id this module names — each Bedrock
 * CATALOG id plus every member of the four geo sets — must appear either as a
 * key here or in NO_GLOBAL_PROFILE_MODEL_IDS below, which carries the per-id
 * reason. bedrock-model-id.spec.ts asserts that partition in both directions
 * against the real catalog, so a NEW id fails the suite until someone
 * classifies it. That guard is the refresh contract: an unclassified Claude id
 * would silently get no global routing and, since the cards mark the base id
 * In-Region ✗ everywhere, be uninvocable outside its geo regions. (PR #3118
 * review finding 2: this header previously claimed "the four such catalog
 * ids", counting two ids the catalog does not carry and missing five it
 * does.)
 */
export const GLOBAL_PROFILE_REGIONS_BY_MODEL: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['anthropic.claude-fable-5', FABLE_GLOBAL_REGIONS],
  ['anthropic.claude-fable-5-1', FABLE_GLOBAL_REGIONS],
  ['anthropic.claude-haiku-4-5-20251001-v1:0', CA_WEST_GLOBAL_REGIONS],
  ['anthropic.claude-sonnet-4-5-20250929-v1:0', CA_WEST_GLOBAL_REGIONS],
  // Opus 4.5 publishes `us.`/`eu.` only — no AU and no JP geo anywhere.
  [
    'anthropic.claude-opus-4-5-20251101-v1:0',
    globalOnlyRegions(
      'ca-west-1',
      'ap-northeast-1',
      'ap-northeast-3',
      'ap-southeast-2',
      'ap-southeast-4',
      'ap-southeast-6'
    ),
  ],
  // Opus 4.6 has AU (incl. NZ) but no JP geo.
  ['anthropic.claude-opus-4-6-v1', globalOnlyRegions('ap-northeast-1', 'ap-northeast-3')],
  ['anthropic.claude-opus-4-7', NZ_ONLY_GLOBAL_REGIONS],
  ['anthropic.claude-opus-4-8', NZ_ONLY_GLOBAL_REGIONS],
  ['anthropic.claude-opus-5', NO_JP_GEO_GLOBAL_REGIONS],
  ['anthropic.claude-opus-5-5', NZ_ONLY_GLOBAL_REGIONS],
  ['anthropic.claude-sonnet-5', NO_JP_GEO_GLOBAL_REGIONS],
  // Sonnet 4.6's card is the widest: US+EU+AU(incl. NZ)+JP(incl. Osaka) geo.
  ['anthropic.claude-sonnet-4-6', globalOnlyRegions()],
]);

/**
 * The OTHER half of the partition described above
 * GLOBAL_PROFILE_REGIONS_BY_MODEL: ids this module names that deliberately get
 * no `global.` prefix, each with its reason. Held as an explicit set — rather
 * than left implicit in "absent from the map" — so the refresh contract is
 * mechanical rather than a prose promise.
 *
 * - CARD PUBLISHES NO GLOBAL INFERENCE ID. `anthropic.claude-opus-4-1-…`
 *   reads "N/A"; `deepseek.r1-v1:0` and the two `meta.llama4-*` routes read
 *   "Not supported". Each is a us-only model whose card lists three or four US
 *   rows with Global ✗ throughout.
 * - NO CROSS-REGION PROFILE OF ANY KIND. The four `amazon.nova-*` catalog ids
 *   and `deepseek.v3.2` are in no geo set here either (models.dev 2026-08-18
 *   lists none, and no card was read for them), so they were already sent
 *   verbatim everywhere. They are listed to record that the omission was
 *   CHECKED, not overlooked — behaviour is unchanged.
 */
export const NO_GLOBAL_PROFILE_MODEL_IDS: ReadonlySet<string> = new Set([
  'amazon.nova-2-lite-v1:0',
  'amazon.nova-lite-v1:0',
  'amazon.nova-micro-v1:0',
  'amazon.nova-pro-v1:0',
  'anthropic.claude-opus-4-1-20250805-v1:0',
  'deepseek.r1-v1:0',
  'deepseek.v3.2',
  'meta.llama4-maverick-17b-instruct-v1:0',
  'meta.llama4-scout-17b-instruct-v1:0',
]);

type PrefixGroup = 'au' | 'eu' | 'jp' | 'us';

/** Exported for the partition guard in bedrock-model-id.spec.ts. */
export const PROFILE_MODEL_IDS_BY_GROUP: Record<PrefixGroup, ReadonlySet<string>> = {
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
  // Geo lost (or does not exist here): fall back to the GLOBAL profile, but
  // only where the model's own card marks this region Geo ✗ / Global ✓. Geo is
  // checked first because data residency is the stronger guarantee, so this
  // can only ever replace an id Bedrock cannot invoke — never downgrade a
  // working geo route. GovCloud is in no global set, so it never lands here.
  if (GLOBAL_PROFILE_REGIONS_BY_MODEL.get(modelId)?.has(region)) {
    return `global.${modelId}`;
  }
  return modelId;
}
