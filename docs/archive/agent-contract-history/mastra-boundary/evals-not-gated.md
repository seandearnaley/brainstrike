# Evals are not gated on this boundary — evidence

Supports `docs/agents/mastra-boundary.md` § "Correction to BST-561 — evals are
NOT gated on this boundary". Read this before citing BST-561's blocking
instruction. API shapes below were read from core 1.51's `.d.ts`; re-read the
installed 1.64.0 declarations before writing eval code.


The archived audit's blocking instruction (*"do not add `@mastra/evals`,
observability packages, or scorer registration until the canonical boundary is
decided"*) is **over-broad and now retired**.

`runEvals` and `createScorer` are in **core 1.51** (`dist/evals/run/index.d.ts`,
`dist/evals/base.d.ts:252-261`). They require **no server, no storage, and no
cloud** — storage only upgrades trajectory scorers from message-derived to
trace-derived. Only *prebuilt* scorers need `@mastra/evals`.

Eval adoption may therefore proceed on its own merits (BST-589) without waiting on
anything in this document.

> Docs-ahead-of-package warning: the official `runEvals` docs describe `inputs`,
> `turns`/`EvalTurn`, and `turnResults`. **None exist at 1.51** — `RunEvalsDataItem`
> has only `input`, `groundTruth`, `expectedTrajectory`, `requestContext`,
> `startOptions`. Write against the installed `.d.ts`, not the docs.

