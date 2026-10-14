# OpenRouter Auto profile and output window — evidence

Supports `docs/agents/assistant-providers.md` § "AI ASSISTANT INTEGRATION". The Auto coding profile, declared auto efforts, and the reasoning-aware output window.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 725-800); append rather than
rewrite.

---

- OpenRouter request options use the native `providerOptions.openrouter`
  namespace. The shared reasoning controls map to
  `{openrouter:{reasoning:{effort,summary},provider:{require_parameters:true}}}`.
  Strict parameter routing is mandatory so OpenRouter cannot silently select an
  upstream route that ignores requested reasoning or tool parameters. Optional reasoning models map the
  explicit Off choice to `{openrouter:{reasoning:{enabled:false}}}`; `none` is
  never sent as a guessed effort. Never reuse the OpenAI camel-case
  `{openai:{reasoningEffort,reasoningSummary}}` shape, which Mastra's OpenRouter
  adapter ignores.
- OpenRouter `Auto` is a zero-configuration coding profile, not an implicit
  provider-wide 4,096-token cap. For a request whose reasoning is OFF the
  shared contract resolves the output limit as `min(model max completion,
  32,000)` when live/static model metadata publishes a maximum, and 32,000
  otherwise, matching OpenCode's coding ceiling. When reasoning metadata says
  reasoning is enabled by default, the
  Auto effort is DECLARED, never inferred (BST-833): `reasoning.autoEffort`
  from our catalog if recorded, else the vendor's `defaultEffort`. With neither
  declared, Auto sends NO effort and the provider applies its own default —
  inventing one would be a silent fallback.
  Do NOT reintroduce the old rule, which scanned `supportedEfforts` for a
  "completion-biased" effort (`minimal`/`low`) and substituted `none` when it
  found none. That discarded the model's own declared default invisibly:
  GLM-5.2 declares `defaultEffort: 'high'` and advertises no low tier, so it
  lost reasoning entirely — for a reason unrelated to any measured budget risk,
  and with nothing surfaced to the user.
  A model that must reason less under Auto records `autoEffort` in the catalog
  (`'none'` switches it off deliberately and greppably) — `moonshotai/kimi-k3`
  does exactly this, because its `max` vendor default spends the whole output
  budget reasoning. Recording a fact we cannot get from OpenRouter is preferred
  over deriving it.
  The output window is NOT independent of effort (BST-1170, retiring the
  BST-833 assumption): OpenRouter documents that reasoning tokens ARE output
  tokens and that a requested effort allocates a share OF `max_tokens` for
  reasoning (high ≈ 80%, max/xhigh ≈ 95%, low ≈ 20%), so a fixed 32K ceiling
  on a reasoning run shrinks the whole thinking+answer window — Kimi K3 at
  explicit `high` thought for minutes and died at `finishReason: length`. A
  model whose vendor documents a completion window sized for always-on
  thinking records it as catalog-only `reasoning.vendorDefaultOutputTokens`
  (Kimi K3: 131,072 per the official K3 quickstart, verified 2026-08-05;
  OpenRouter publishes no max completion for that route). Whenever the request
  actually reasons — explicit effort, or the model's declared Auto/default
  resolution — `resolveOpenRouterOutputWindow` sends that window (capped by a
  declared model max completion); reasoning-off requests and models without
  the recorded fact keep the coding ceiling. The window is a truncation cap,
  not a spend target. The fact is recorded from vendor docs only — GLM-5.2
  documents no default window, so it deliberately has none. All three
  resolution sites share the rule: `buildEffectiveModelSettings` (app-shell),
  `resolveOpenRouterMetadataDisabledReason`'s input-budget reservation, and
  the agent-side `modelSettings` backstop in
  `packages/agent/src/mastra/agent-streaming.ts`.
  OpenRouter effort is a provider
  hint, not a deterministic reservation. The resolved output value drives both
  Mastra `modelSettings` and the input-context reservation. Explicit reasoning
  choices remain authoritative, and output values above a known model maximum
  are surfaced rather than silently clamped.
  The model menu and the per-thread provider-options builder must use the same
  resolved live metadata snapshot. It is invalid for the menu to offer an
  effort from live OpenRouter metadata and then validate that selection against
  a stale static catalog while composing the thread draft.
- A newly readable OpenRouter configuration must be usable without visiting
  model settings. When the DB-backed OpenRouter catalog is untouched, app-shell
  enables the small `OPENROUTER_RECOMMENDED_CODING_MODEL_IDS` set (balanced
  GPT-5.6 Terra, long-horizon Kimi K3, Qwen3.7 Max, GLM 5.2, and MiniMax M3) in
  one durable write. GLM 5.2 exposes only OpenRouter's documented `high` and
  `xhigh` reasoning efforts. MiniMax M3 is multimodal, so its static and
  persisted catalog declarations both enable image input.
  The database model registry remains the picker source of truth. Any existing
  enabled model, or any row whose `updated_at` is later than `created_at`, is an
  explicit prior choice—including an intentional all-disabled choice—and must
  be preserved exactly. Catalog migrations therefore continue preserving both
  `is_enabled` and the timestamps on existing rows. Key replacement, reload,
  and catalog refresh never reapply defaults; an unreadable key never triggers
  initialization. Missing recommended catalog rows or failed persistence are
  surfaced visibly rather than enabling a partial set or falling back to the
  whole OpenRouter catalog. Hosted fixed-provider runtimes do not run this
  desktop/local configuration initializer.
