# Bedrock model id prefixing — evidence

Supports `docs/agents/assistant-providers.md` § "Amazon Bedrock". The geo tables, the model-card precedence ruling, `global.` routing, and the open follow-ups.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 1831-1924); append rather than
rewrite.

---

- **Model ids are stored UNPREFIXED** (registry + DB catalog, migration
  100). The cross-region inference-profile prefix (`us.`/`eu.`/`jp.`/`au.`
  geo, or `global.`; `apac.` passes through if already present) is applied per
  request by `packages/agent/src/providers/bedrock-model-id.ts`. Since the
  PR #2522 review (finding 2/3) the geo tables are EXACT profile-id sets
  derived from models.dev ground truth (dated in the module header) — a geo
  prefix is emitted only when that regional profile is listed; otherwise the id
  is sent verbatim and Bedrock reports the outcome. Never double-prefixes;
  `us-gov*` excluded from `us.`; no `apac.` profiles exist today. Refresh
  procedure lives in the module header.
- **An AWS model card OUTRANKS models.dev (BST-1694, PR #3080 review;
  `jp.` set audited to completion in BST-1710).** models.dev is a third-party
  mirror: it can list a regional profile AWS never published, and it can
  equally MISS one AWS does publish. Emitting a profile AWS does not publish is
  a client-MANUFACTURED failure, strictly worse than the verbatim id Bedrock
  can answer for. Where a card enumerates a model's profiles the card wins, and
  the divergence is recorded inline in the module header.
  - **Phantoms removed:** `anthropic.claude-opus-5` (BST-1694) and
    `anthropic.claude-sonnet-5` (BST-1710) are NOT in the `jp.` set. Each
    card publishes `us.`/`eu.`/`au.`/`global.` only, carries no "Geo: JP"
    section, and marks ap-northeast-1 In-Region ✗ / Geo ✗ / Global ✓.
  - **The audit cuts both ways:** BST-1710 also found
    `anthropic.claude-opus-4-7` MISSING from the `au.` set although its card
    publishes `au.anthropic.claude-opus-4-7` and marks ap-southeast-2/-4
    Geo ✓ — so ap-southeast-2/-4 were emitting an id Bedrock cannot invoke.
    It was ADDED. Under-emission and over-emission are the same defect.
  - **Card-verified as published, kept in `jp.`:** `anthropic.claude-opus-4-7`,
    `anthropic.claude-opus-4-8`, `anthropic.claude-sonnet-4-5-20250929-v1:0`,
    `anthropic.claude-sonnet-4-6`,
    `anthropic.claude-haiku-4-5-20251001-v1:0` (retrieved 2026-09-10). Ids
    whose cards were not read keep their models.dev membership; none of them
    is in the `jp.` set, so none can be a `jp.` phantom.
  - **Closed by BST-1711 (next bullet):** removing a phantom used to leave
    Tokyo on the verbatim id, because the module emitted no `global.` ROUTING
    at all. It does now, so the two rows the audit had to leave verbatim
    resolve to `global.anthropic.claude-opus-5` and
    `global.anthropic.claude-sonnet-5` in ap-northeast-1 — exactly what those
    cards publish for it.
- **`global.` ROUTING, and its precedence (BST-1711).** The current Claude
  cards mark the BASE model id In-Region ✗ in EVERY region, so the bare
  `anthropic.claude-opus-5` is not invocable at `bedrock-runtime` anywhere — a
  geo or global profile is mandatory, and AWS's own card sample code calls
  `global.<id>`. The module now emits `global.` from a per-MODEL table of the
  regions each card marks **Geo ✗ / Global ✓**, transcribed from the cards'
  Regional Availability tables (never models.dev).
  - **Precedence is geo → global → verbatim.** Data residency is the stronger
    guarantee, so a region that has a geo profile for that model keeps it.
    Because global is only ever consulted after geo misses, and only for
    regions the card marks Geo ✗, this can only REPLACE an uninvocable
    verbatim id — it can never downgrade a working geo route.
  - **GovCloud never receives `global.`** — `us-gov-west-1`/`us-gov-east-1`
    are Global ✗ on every card that lists them (Opus 5, Fable 5.1, Sonnet
    4.5), so they are in no global set. Pinned by a spec case.
  - **A model absent from the table never gets `global.`, and that absence is
    a DECISION, not a default.** Every id this module names — each Bedrock
    catalog id plus every member of the four geo sets — must appear either as
    a key of `GLOBAL_PROFILE_REGIONS_BY_MODEL` or in
    `NO_GLOBAL_PROFILE_MODEL_IDS`, whose comment carries the per-id reason
    ("N/A" / "Not supported" on the card, or no cross-region profile of any
    kind). `bedrock-model-id.spec.ts` asserts that partition in both
    directions against the real catalog, so a newly added id fails the suite
    until someone classifies it. That is the refresh contract: an unclassified
    Claude id would otherwise be silently uninvocable outside its geo regions.
  - The table is per model because the cards genuinely disagree: Opus 4.5 has
    no AU geo (Sydney is global-only for it alone), Fable 5/5.1 have no EU geo
    (all eight EU regions are global-only), and `ca-west-1` is Geo ✗ on the
    Haiku 4.5 / Sonnet 4.5 cards but Geo ✓ on others.
  - **Shadowed entries are enumerated, not implied.** Because geo is checked
    first, a global entry for a region the model ALSO has a geo profile in is
    dead code. Exactly one such family exists today — `fable-5` in the seven
    mapped EU regions, where the `eu.` set is itself a suspected phantom (see
    Still open). It is kept, not deleted, because the fix is to drop the
    phantom rather than the global row; a spec case iterates the whole table
    and fails if any UNLISTED shadowed pair appears.
  - **Still open (follow-up):** the GEO map is still prefix-shaped, so regions
    the cards mark Geo ✓ that it does not map keep sending the verbatim id —
    `ca-central-1`/`ca-west-1`, `eu-central-2`, `ap-northeast-3`,
    `ap-southeast-6`. Those are UNDER-emissions. Also
    `anthropic.claude-fable-5` sits in the `eu.` set although its card
    publishes `us.`/`global.` only — a BST-1710-class phantom found while
    building the global table, filed rather than folded in. Its visible
    symptom is a split INSIDE the EU: `eu.anthropic.claude-fable-5` in
    `eu-west-1` (mapped, geo wins) but `global.anthropic.claude-fable-5` in
    `eu-central-2` (unmapped, global wins). Both are pinned, so closing the
    phantom has to change them deliberately.
- **Exclusions:** no embeddings (`createEmbeddingProvider` throws), not a
  persistent-memory provider (`PERSISTENT_MEMORY_LANGUAGE_MODEL_PROVIDERS`),
  and NOT in `HOSTED_WEB_ASSISTANT_PROVIDERS` (desktop-only until a web ticket
  says otherwise). `@ai-sdk/amazon-bedrock` is Node-only: it is imported
  solely from provider-factory-adjacent modules, never from the browser-safe
  agent subpaths. Web's exclusion is enforced STRUCTURALLY as well as by that
  list: no `awsCredentialChain` capability is injected there, so a
  profile-chain credential cannot resolve on web even if the provider list
  changed.
