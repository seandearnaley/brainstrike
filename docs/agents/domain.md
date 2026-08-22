# Domain documentation for external skills

> **Consumer:** external domain-modeling and triage skills installed in an
> agent environment. They are not vendored by this repository; this file tells
> them how to consume Brainstrike's current contracts.

## Read order

Before exploring a subsystem:

1. Read `AGENTS.md` and use its routing table to select the matching
   `docs/agents/` contract.
2. Read relevant accepted decisions under `docs/adr/`.
3. Verify terminology and behavior against current source and tests. Treat
   dated plans, research, and archives as historical evidence.

## Single-context glossary seam

This repository uses a single-context domain layout. Its root glossary has not
yet been created. If a domain-modeling session resolves durable vocabulary, the
conventional root `CONTEXT.md` is the one glossary location; create or update it
only from user-approved decisions.

Until that file exists, use the terminology in `AGENTS.md`, the routed
`docs/agents/` contract, source, tests, and accepted ADRs. Do not cite a missing
glossary, invent definitions, or treat synonyms as settled project language.

## Vocabulary and decisions

Once a root glossary exists, use its defined terms in issue titles, refactor
proposals, hypotheses, and test names. A missing concept is either language the
project does not use or a domain-modeling gap to surface; it is not permission
to silently coin a competing term.

If proposed work contradicts an accepted ADR, state the conflict and the reason
to reopen the decision rather than silently overriding it.
