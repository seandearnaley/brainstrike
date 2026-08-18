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
- The one behavior needing an explicit product constraint: Brainstrike can run long agentic
  tasks. "Unattended production automation" is the nearest prohibited category, so the connect
  UI must frame this auth mode as personal/interactive use.

**Decision: APPROVED WITH CONSTRAINTS — signed Sean Dearnaley, 2026-08-18** *(pending — this line
is finalized by the sign-off; see PR discussion. Until edited to remove this parenthetical, the
gate is NOT passed.)*

**Binding constraints on BST-1355 / BST-1356:**
1. Each user authenticates their own account; no shared, bundled, or Brainstrike-supplied
   credentials, ever.
2. No server-side proxying of subscription traffic — requests go device → OpenAI directly.
3. Tokens: safeStorage-encrypted local store only; never in logs, telemetry, run-error envelopes,
   RuntimeData, or RequestContext; wiped by factory reset.
4. The connect UI states plainly that this uses the user's ChatGPT subscription for their own
   personal use in Brainstrike, and that commercial/multi-user serving requires platform API keys.
5. Identify honestly: `originator: brainstrike` — never impersonate another tool's originator
   string. (The client id is OpenAI's published public client for this flow, per Zed/opencode
   precedent.)
6. Surface subscription rate-limit responses verbatim (bounded) so users understand quota, and
   never auto-retry around them.
7. SECURITY.md gains a section describing the token store and threat model (per P8.4).
8. Re-verify endpoints/constants and this assessment against opencode HEAD + official docs at
   implementation time; material ToS changes reopen this gate.

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
