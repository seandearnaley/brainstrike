# ADR-0031: Access modes and auto-review

- **Status:** Accepted
- **Date:** 2026-10-30

## Context

Codex and Claude Code put an access control in the composer: ask for every
action, let a reviewer approve routine ones, or allow everything. Brainstrike
had the first and last as a Settings policy and a YOLO switch, and no middle
mode. The owner asked for all three in the composer, with the middle one judged
by a separate quick model through the AI SDK (2026-10-30).

Prior art read before designing: Codex's auto-review (`codex-rs/ext/guardian-reviewer`,
`prompts/templates/guardian/policy.md`), which reviews only the calls that would
otherwise ask, sees a compact transcript, fails closed and answers
`{ outcome, risk_level, user_authorization, rationale }`; and Anthropic's Claude
Code auto mode write-up, whose classifier sees user messages and tool calls but
never tool results or the assistant's prose, so injected content cannot argue
for its own approval.

## Decision

- **One saved fact.** The saved permission policy's `yolo` switch becomes
  `access: 'ask' | 'auto' | 'full'`, with `autoReviewModel` (`auto` or a
  `provider/model` target). The host keeps it, as before (BST-1930 stage e); the
  composer and Settings both write it through the existing store.
- **The gate is unchanged.** `full` is the gate's `yolo`; `auto` adds
  `autoReview` to the snapshot. Explicit denies, grants and children's frozen
  denies keep their ADR-0010 meaning, and a child follows its root's live mode.
- **The reviewer only approves or asks.** In auto mode a call the policy
  resolves to `ask` goes to the AI SDK `toolApproval` callback's quick-model
  review first. Its approval returns the SDK's automatic `approved` with a reason
  and the call runs; a flag, a high-risk approve, any failure (no model, provider
  error, unreadable answer, the 60-second bound) returns `user-approval` with a
  reason the card shows. Auto never approves by default and never denies on its
  own, so it needs no denial circuit breaker: the person is the breaker. Network
  consents, questions and plans always go to the person.
- **What the reviewer sees.** The person's requests, the assistant's tool calls
  and the call under review, each clipped. Never tool results or assistant
  prose. A request is a user message the person wrote, read from the run's
  committed branch rather than from message roles: a delegation's task, a
  wake's child results and a delivery ledger reach the model as user messages,
  but a model wrote them, so they never read as the user. A child's review
  starts from the path of the run that delegated it, so it judges against the
  root person's request.
- **Which model.** `auto` is the chat provider's first quick model, from the one
  per-provider list the auto observer also uses, so the review never reaches a
  provider that is not already in the conversation. Structured output uses
  `Output.object` over an Effect Schema with `reasoning: 'low'`.
  `experimental_decide` was considered and not used: it is experimental and
  needs provider decision models Brainstrike does not build.

## Consequences

- A reviewed approval is the SDK's automatic approval in the run's stream; a
  flagged one is an ordinary `interaction.requested` carrying `reason`.
- Each reviewed call costs one quick-model request on the chat provider.
- The reviewer can be wrong in both directions. Claude Code reports a 17%
  false-negative rate on its own hard set; auto is a convenience over Ask, not
  a security boundary, and Full access stays the explicit unsafe choice.
