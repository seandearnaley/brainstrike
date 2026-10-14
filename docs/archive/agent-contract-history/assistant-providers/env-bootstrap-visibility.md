# Env bootstrap visibility — evidence

Supports `docs/agents/assistant-providers.md` § "Env bootstrap visibility". Why the surface exists, the names-only payload rule, and the settled rulings behind it.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 2133-2214); append rather than
rewrite.

---

Why it exists: env-file bootstrap was invisible. One malformed line makes the
loader reject the WHOLE file (see the env-file rules above — validation is
all-or-nothing by design), so every credential in it silently stops applying
and the app behaves exactly as if the keys were never set. Settings now states
the outcome instead of leaving the user to guess.

**Payload rule — NAMES ONLY, NEVER VALUES (do not relitigate).** The
projection carries variable NAMES, file PATHS, counts, and the loader's own
failure messages. It never carries a variable's value, nor a prefix, hash, or
length of one. The producer
(`apps/desktop/src/desktop-env-report.ts`) builds the name lists by
intersecting the allow-listed NAME sets
(`CREDENTIAL_ENV_FILE_VARIABLE_NAMES` /
`NON_CREDENTIAL_SUPPORTED_ENV_FILE_VARIABLE_NAMES`) with mere PRESENCE in the
process environment — a value is read only to ask "is this non-blank?", so it
has no path into the payload by construction rather than by a post-hoc scrub.
`apps/desktop/src/__tests__/desktop-env-report.test.ts` seeds a distinctive
fake key value and asserts the serialized payload does not contain it. This
matches the `deprecatedEnvVars` precedent: names only, never values.

Shape and transport: `EnvBootstrapReport` is defined ONCE in
`packages/assistant-contract/src/env-bootstrap-bridge.ts` (with the
`ENV_BOOTSTRAP_BRIDGE_REQUIRED_METHODS` pin the preload-runtime contract test
enforces). Channel `secrets:envBootstrap` is registered in
`apps/desktop/src/ipc-secrets.ts` with the same `visible-ui` role policy as
every other secrets channel; `hidden-preload.ts` does not expose it
(negatively asserted in `hidden-preload-contract.test.ts`).

Rulings worth keeping:

- The handler reads the RECORDED bootstrap result and re-projects it per
  invoke. It NEVER re-runs loading — `initializeDesktopEnvironment` throws on
  double-init, and re-reading files would report a state the running process
  is not actually in. This is also why the UI states "Changes to environment
  files apply after restart."
- Unlike `secrets:list`, this channel deliberately does NOT throw on env-file
  failures. `secrets:list` throwing is correct (its answer would be wrong);
  this channel exists precisely to explain that failure, so it must still
  answer.
- The section reads ONCE on mount. It deliberately does NOT subscribe to
  `SECRETS_CHANGED_EVENT_NAME` or window focus: the payload derives from the
  recorded bootstrap plus the process environment, and neither can change
  without a restart, so a refresh could only ever re-fetch an identical
  payload while implying the panel is live. Do not add one back.
- Deprecation guidance has ONE source. The rename target is
  `DeprecatedEnvVarReport.replacement` — the VENDOR-standard name, never the
  `BRAINSTRIKE_*` override — and both the inventory row and the Environment
  section render it through the single
  `settings/secrets/deprecated-env-var-message.ts` helper. A second derivation
  previously advised the override while the row advised the vendor name, with
  both on screen simultaneously. Do not re-derive it.
- A name counts as retired based on the REGISTRY
  (`providerDeprecatedEnvKeys`), not on whether the loader saw it in a file.
  A retired name exported from the user's shell is just as dead as one spelled
  in `.env`, so neither may render as a live chip; file provenance only adds a
  clause to the warning.

File ids (`dev` / `dev-local` / `user-data`) are internal loader vocabulary and
must never reach the UI. `DESKTOP_ENV_FILE_LABELS` in the contract is the ONE
map to their real filenames, and the loader itself formats failure messages
through it — so the same wording reaches Settings, the status probe, and the
`secrets:list` error.

Surface: `packages/settings-ui/src/settings/secrets/environment/`, rendered
beneath the Credential Inventory. Read-only — no editor, because the values
are secrets this surface must never handle. The failure banner reproduces the
parser's line-precise message verbatim (`… is invalid at line 4: unsupported
variable name.`) — that text is the feature, so do not re-word it — and states
the all-or-nothing consequence, since one bad file discards them all.
Effective variables render as monospace chips, credential chips visually
distinct from non-credential config chips and cross-linked to their inventory
row; the chip→row index is built from `listCredentialSlots()` so a chip can
never target a row that does not exist. The "Open folder" affordance is
INJECTED by the desktop host from `resolvePlatformBridge()`, and its
`{ ok, error }` result is surfaced — settings-ui never touches
`window.platform`, and web omits the section entirely by capability (the
bridge is absent), never by an `isElectron()` check.

Tavily's env names are NOT in the provider registry (it is a search service,
not a model provider). The canonical list lives in
`@brainstrike/assistant-contract/tavily-env-keys` because both desktop and
settings-ui need it; every local copy that existed instead had drifted.
