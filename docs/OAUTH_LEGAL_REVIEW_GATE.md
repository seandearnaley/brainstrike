# OAuth Legal Review Gate — Subscription-Auth Providers

> Ruling record for [P8.4 OAuth — LEGAL GATE] (`docs/coding-agent-issue-ledger.md`) and Linear BST-1351.
> No subscription-OAuth implementation work (BST-1355 OAuth engine, BST-1356 Codex provider) starts
> before the decision section below is signed. This document is the durable record; update it —
> never relitigate in PR threads.

## Scope

"Subscription OAuth" means signing a user into a **consumer subscription** (ChatGPT Plus/Pro,
Claude Pro/Max, GitHub Copilot, SuperGrok) from inside Brainstrike so model usage draws on that
subscription instead of metered platform-API billing. Plain API-key auth is out of scope — it is
uncontroversially permitted by every provider's platform terms.

## Provider assessments

### OpenAI — ChatGPT sign-in for Codex (BST-1356)

**Evidence reviewed (retrieved 2026-08-18):**

| Evidence | What it establishes |
| --- | --- |
| [Codex authentication docs](https://developers.openai.com/codex/auth) (official) | ChatGPT sign-in is OpenAI's documented, supported auth mode for Codex; device-code flow is offered for headless use; credentials cached locally (`auth.json` / OS credential store); tokens auto-refresh. |
| [Zed's announcement](https://zed.dev/blog/chatgpt-subscription-in-zed) | Zed shipped ChatGPT-subscription sign-in **in collaboration with OpenAI** ("excited to work with OpenAI…", "grateful that OpenAI continues to support subscription-based access for third-party tools"). Uses the official Codex CLI client id, OAuth 2.0 + PKCE, loopback 127.0.0.1:1455 — the exact mechanism BST-1356 specifies. |
| opencode v1.18.2 (`packages/opencode/src/plugin/openai/codex.ts`) | Ships the same flow natively in an open-source agent, using the official client id (`app_EMoamEEZ73f0CkXaXp7hrann`), `originator` header identifying the third-party tool — i.e. the protocol *itself* carries a third-party-tool identifier, which only makes sense if third-party tools are an anticipated caller. |
| [OpenAI Terms of Use](https://openai.com/policies/row-terms-of-use/) / [Services Agreement](https://openai.com/policies/services-agreement/) (June 2026 revisions) | Subscriptions are personal: no credential sharing, user responsible for account activity. Nothing prohibits using one's own account through a client of one's choosing. |
| [Manifest: "This will get you banned"](https://manifest.build/blog/banned-from-chatgpt-subscriptions/) (community analysis, no direct OpenAI quotes) | The ban-risk behaviors are: sharing one subscription across users, unattended production automation, serving third parties, and embedding subscription credentials in a shipped commercial product. The distinction drawn is *personal use vs anything past it*. |

**Assessment.** Brainstrike's integration is structurally identical to the sanctioned Zed/opencode
pattern and structurally different from every ban-risk pattern:

- Each user signs into **their own** account on **their own** device; Brainstrike is local-first
  and has no server that could proxy, pool, or resell subscription traffic.
- Tokens live only in the user's OS-encrypted local store (safeStorage), never in telemetry,
  never on any Brainstrike infrastructure.
- Brainstrike does not ship credentials with the product; it ships a sign-in *flow*.
- On automation: the prohibited category ("production systems calling the API while you're not
  in the loop", multi-user serving) describes *services*, not a developer running long agentic
  coding tasks they initiated — the latter is exactly what OpenAI's own Codex CLI/Cloud does
  under subscription auth. The line Brainstrike must not cross is offering this auth mode to
  any non-interactive context, which constraint 4 below makes an enforceable product
  restriction, not UI copy.

**Residual risks (accepted only if signed below):**
- **Client registration identity.** The flow uses OpenAI's public Codex CLI client id, per
  ecosystem precedent (opencode ships it natively; Zed's integration uses the official Codex CLI
  client id). OpenAI has visibly tolerated and, in Zed's case, collaborated on this pattern —
  but Brainstrike has no written authorization of its own, and OpenAI could revoke or restrict
  that client id at any time. Mitigations in constraint 5: honest `originator` identification,
  and a standing action to obtain a Brainstrike-registered client (or written confirmation)
  if/when OpenAI offers a channel. If OpenAI blocks the shared client id, the feature degrades
  to a visible "reconnect unavailable" state — never a workaround.
- **Terms drift.** The evidence is dated 2026-08-18; a material ToS change reopens this gate.

**Decision: APPROVED WITH CONSTRAINTS — Sean Dearnaley, 2026-08-18.** Sign-off given directly in
the working session ("rulings look good, I would follow your recommendations") after review of
this assessment including the residual-risk section. The 8 constraints above are binding
acceptance criteria on BST-1355 and BST-1356; the residual risks are accepted as written.

**Binding constraints on BST-1355 / BST-1356:**
1. Each user authenticates their own account; no shared, bundled, or Brainstrike-supplied
   credentials, ever.
2. No server-side proxying of subscription traffic — requests go device → OpenAI directly.
3. Tokens: safeStorage-encrypted local store only; never in logs, telemetry, run-error envelopes,
   RuntimeData, or RequestContext; wiped by factory reset.
4. **Interactive-desktop-only (enforceable, not copy):** the `openai-codex` provider is
   resolvable only in interactive desktop sessions — it must be structurally unavailable to any
   scheduled, headless, server, or multi-user execution context, now or added later (enforce at
   the credential-resolution layer with a test, so a future headless mode fails closed for this
   provider). The connect UI additionally states this uses the user's own ChatGPT subscription
   for personal use, and that commercial/multi-user serving requires platform API keys.
5. Identify honestly: `originator: brainstrike` — never impersonate another tool's originator
   string. The public Codex CLI client id is used per ecosystem precedent (see Residual risks);
   pursue a Brainstrike-registered client or written OpenAI confirmation if a channel exists,
   and record the outcome here. Client-id revocation by OpenAI is handled by failing visibly.
6. Surface subscription rate-limit responses verbatim (bounded) so users understand quota, and
   never auto-retry around them.
7. SECURITY.md gains a section describing the token store and threat model (per P8.4).
8. Re-verify endpoints/constants and this assessment against opencode HEAD + official docs at
   implementation time; material ToS changes reopen this gate.

#### Implementation record — BST-1356 (2026-08-18)

Recorded here per constraints 5 and 8, which require the outcome to land in
this document rather than in a PR thread.

**Constraint 8 — re-verification at implementation time.** Every endpoint and
constant was re-verified against opencode HEAD on 2026-08-18. Two findings:

1. **The repository moved.** `sst/opencode` was renamed to
   `anomalyco/opencode`, and its default branch is `dev`, not `main`. The
   re-verification was performed against `anomalyco/opencode` `dev` HEAD
   `0033bb3559`. (`raw.githubusercontent.com` does not follow GitHub's rename
   redirect, so the old URL 404s rather than redirecting — worth knowing for
   the next re-verification.)
2. **Two changes since the v1.18.2 baseline**, both landed 2026-08-17:
   - *#39082* collapsed the `gpt-5.6` context-limit override into gpt-5.5's
     (400k/272k/128k). MOOT for Brainstrike — `gpt-5.6` is excluded from the
     allowed set upstream and here.
   - *#42432* added data-residency routing: a `chatgpt_compute_residency`
     claim on the ACCESS token is forwarded as
     `x-openai-internal-codex-residency` when the request is rewritten onto
     the Codex backend. Brainstrike MIRRORS this, because omitting it would
     mis-route requests for region-constrained accounts. Note the claim
     precedence is namespaced-first, the OPPOSITE of the account-id read;
     that asymmetry is deliberate upstream and is reproduced, not "corrected".

Everything else — client id, issuer, authorize/token endpoints, loopback port
1455 and `/auth/callback`, scopes, extra authorize params, the non-standard
device-flow endpoints and their 403/404-means-pending semantics, the
server-supplied `code_verifier` exchange with
`redirect_uri https://auth.openai.com/deviceauth/callback`, the
`ALLOWED_MODELS` set, and the account-id claim precedence — is UNCHANGED from
the baseline recorded above.

No material change to OpenAI's Terms of Use or the Codex authentication
documentation was found on re-retrieval, so the gate does not reopen.

**Constraint 5 — client registration identity.** Brainstrike sends
`originator: brainstrike` in both the authorize parameters and every Codex
request, and a `brainstrike/<version>` User-Agent. It never sends another
tool's originator string (pinned by test). The OAuth client id remains
OpenAI's public Codex CLI registration, per the ecosystem precedent in
Residual risks above. **No Brainstrike-registered client was obtained: OpenAI
currently offers no public channel to register a third-party Codex OAuth
client, and no written confirmation was sought or received.** The residual
risk therefore stands exactly as accepted above. Revocation of the shared
client id surfaces as a visible typed error, never a workaround. Re-check for
a registration channel at the next material product change.

### Anthropic — Claude Pro/Max OAuth

**Decision: PERMANENTLY REJECTED (do not relitigate).** Anthropic explicitly prohibits third-party
use of Claude subscription auth. opencode bundled community plugins for it and **removed them in
v1.3.0**, documenting the prohibition (opencode `packages/web/src/content/docs/providers.mdx:353`).
Anthropic access in Brainstrike is API-key only. Any future proposal must arrive with a written
Anthropic policy change in hand.

### GitHub Copilot — device-flow subscription auth

**Decision: DEFERRED — not assessed.** opencode ships it; GitHub's position on non-IDE third-party
clients is less clearly documented than OpenAI's. If pursued, complete this table with the
Copilot-specific terms (GitHub Terms for Additional Products, Copilot section) before any
implementation ticket is filed.

### xAI — SuperGrok OAuth

**Decision: DEFERRED — not assessed.** opencode ships it reusing the public Grok-CLI client id.
Assess xAI consumer terms if/when a SuperGrok ticket is proposed (after BST-1356 ships and proves
the engine).

## Process notes

- The Linear label `legal-gate::oauth` marks gated tickets (BST-1355, BST-1356); it comes off
  when this document's OpenAI decision line is finalized.
- Retrieval dates matter: terms change. Each evidence row above carries its retrieval date;
  re-retrieve on material product changes (e.g. if Brainstrike ever gains a hosted/server mode,
  constraint 2's premise changes and this gate REOPENS).
