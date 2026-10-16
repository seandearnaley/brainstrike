# Provider cassettes

A provider cassette is one scenario's real model-provider HTTP exchanges,
recorded once and replayed byte for byte. On replay the real provider packages
(`@openrouter/ai-sdk-provider`, `@ai-sdk/anthropic`, `@ai-sdk/openai`) parse what
the provider actually sent. A hand-written emulator would encode only what we
assume providers send: the 2026-10-16 bugs (#3713, #3719, #3720, #3725, #3727)
all lived in that gap.

## What runs where

| Piece | Owner |
| --- | --- |
| Format, recorder, replay, matching, findings | [`provider-cassette.ts`](../../packages/test-utils/src/provider-cassette.ts) |
| Cassettes | `packages/test-utils/fixtures/provider-cassettes/<scenario>.json` |
| Scenarios: prompts, models, what each recording must show | [`provider-cassette-scenarios.ts`](../../apps/desktop/e2e/utils/provider-cassette-scenarios.ts) |
| Committed-log invariants | [`conversation-invariants.ts`](../../apps/desktop/e2e/utils/conversation-invariants.ts) |
| Shape plus projection invariants | [`conversation-shape.ts`](../../apps/desktop/src/__tests__/helpers/conversation-shape.ts) |
| Host lane, standalone host | `pnpm --filter @brainstrike/desktop test:provider-cassettes` |
| Desktop E2E | `apps/desktop/e2e/provider-cassettes.desktop.test.ts` |
| Ad-hoc capture from any client | `pnpm cassettes:proxy --out <file.json>` |

The model-provider shim serves a cassette when its script is
`{ cassette, substitutions, pace }`. Each request claims the first unserved
exchange recorded under the same key. Two kinds of request are keyed:

- **Streamed or tool-offering:** knob, route, model, the conversation's first
  user message, and its number of conversation items. The system prompt and
  tool definitions are not part of the key, because those are the host's to
  change.
- **One-shot without tools:** model and order alone. This is how a thread
  title is matched.

A request with no matching exchange is refused (`unrecorded-exchange`, naming
its key and the keys still unserved). A lane fails on any refusal or unserved
exchange.

`pace: 1` replays the recorded chunk times. Background children then settle in
their recorded order, so the parent wakes the same number of times.

## Invariants and shape

Each lane derives the settled conversation's shape and its violations:

- the projection folds every row;
- a step's adjacent text blocks are one part;
- no tool row runs, and nothing streams, after `run.finished`;
- a delegation card's count equals its child's ledger;
- the first completed run's title commits before its `run.finished`;
- no tool result is the guard's generic `tool_failed` fault.

The shape names groups, row verbs and states, paragraphs per step, children and
title timing. It is snapshotted (`__snapshots__`), never text.

## Record a scenario

Recording makes paid provider calls with your own key. Export only the
scenario's provider key in your shell (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`
or `OPENAI_API_KEY`), then:

```bash
BRAINSTRIKE_PROVIDER_CASSETTE_RECORD=openrouter-empty-args-tool-call pnpm --filter @brainstrike/desktop test:provider-cassettes -u -t openrouter-empty-args-tool-call
```

`all` records every scenario. A recording is written only if it passes four
checks:

1. Nothing in it trips the secret scanner (`scripts/secret-scan.mjs`), and it
   holds no home directory, user name, workspace path or the key itself.
   Requests keep only protocol headers, never auth.
2. It shows the behavior its scenario exists for (`exhibits`), for example
   GLM's empty-arguments tool frame.
3. It keeps every invariant.
4. It replays to the same shape.

Review the shape snapshot diff before committing.

Prompts name workspace-relative paths and pass no root, so a cassette replays
in any workspace and in both lanes. A model that writes an absolute path fails
check 1. Record the scenario again, or tighten its prompt.

## Capture from the app

`pnpm cassettes:proxy --out capture.json` prints the three base-URL knobs. Start
the dev app on a disposable profile with them set, reproduce the issue, then
press Ctrl-C. It applies the same findings check. To make a capture a lane
scenario, write its scenario entry and record it through the lane.

## Phase 2

- A cheap-model live canary: Gemini Flash, GLM/Qwen Flash via OpenRouter, Haiku
  and a GPT mini. It asserts invariants only and saves new shapes as cassettes.
- A debug-pack-to-fixture converter.
- A deterministic not-ready native index in an Electron lane, so the grep
  refusal path (#3727) runs with real provider bytes.
