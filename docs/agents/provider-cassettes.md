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
| Recording checks: findings, secret scan, key, upstreams | [`provider-cassette-recording.ts`](../../apps/desktop/e2e/utils/provider-cassette-recording.ts) |
| Record scenarios (host lane, or the desktop app) | `pnpm cassettes:record <scenario id\|all>` |
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
title timing. It is kept as one shape file per scenario, never text.

## Record a scenario

Recording makes paid provider calls with the owner's own keys. Agents never read,
print or export a key, and never use the owner's main profile unless the owner
approves it for that task. Choose one route:

1. **Keys the owner exports.** Export only the scenario's provider key in your
   shell (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`), then
   run `pnpm cassettes:record <scenario id|all>`. It records one scenario at a
   time and stops at the first failure. Most scenarios record in the host lane.
   `openrouter-provider-error` records with a deliberately invalid key.

   A scenario marked `recordedIn: 'desktop'` records in the desktop app
   instead, because the app sends what the standalone host never does: thinking
   disabled and its own tool set. The wrapper builds the app and runs the
   desktop E2E in record mode with only the shell's basics and that one key,
   under `BRAINSTRIKE_PROVIDER_CASSETTE_RECORDER_KEY`: E2E global setup strips
   every inherited provider credential (BST-1931). The test takes the key out of
   its environment before the app launches, so only the disposable profile's
   credential store holds it. The recording must replay in the app to the same
   committed shape. The host lane
   then replays it for the projection checks and writes its shape file. If
   either replay fails, the wrapper puts the old cassette back.

   To try a recording route offline, set `BRAINSTRIKE_PROVIDER_CASSETTE_UPSTREAMS`
   to a JSON object of knob to local stand-in base URL, as
   `cassettes:proxy --upstream` does.
2. **The app's own credentials.** Start the recorder with
   `pnpm cassettes:proxy --out <file.json>`, which prints the three base-URL
   knobs. Start the dev app with those knobs set, on a profile that holds keys
   and that the owner approved for this, then reproduce the scenario. Ctrl-C
   writes the capture. The proxy only forwards the app's own headers. Use this
   for ad-hoc and desktop-only captures. A lane scenario replays reliably only
   when the app called the same tools the standalone host offers.

Either route writes a cassette only if it passes four checks:

1. Neither the requests nor the responses trip the secret scanner
   (`scripts/secret-scan.mjs`), and nothing holds the home directory, user name
   or the key itself. Requests keep only protocol headers, never
   auth. A tool result in a request can carry a leaked key.
2. It shows the behavior its scenario exists for (`exhibits`), for example
   GLM's empty-arguments tool frame.
3. It keeps every invariant.
4. It replays to the same shape: the host lane's shape for a host recording,
   or the committed shape in the app for a desktop recording.

The proxy applies check 1. Each scenario's shape is a file,
`apps/desktop/src/__tests__/__snapshots__/provider-cassettes/<id>.shape.json`;
review its diff before committing.

Prompts name workspace-relative paths and pass no root, so a cassette replays
in any workspace and in both lanes. A model that writes the disposable
workspace path into a tool call fails check 4, because the replayed call
targets a folder that no longer exists. Record the scenario again, or tighten
its prompt.

## Phase 2

- A cheap-model live canary: Gemini Flash, GLM/Qwen Flash via OpenRouter,
  Claude Haiku 5.5 and GPT-6 Luna. It asserts invariants only and saves new shapes as cassettes.
- A debug-pack-to-fixture converter.
- A deterministic not-ready native index in an Electron lane, so the grep
  refusal path (#3727) runs with real provider bytes.
