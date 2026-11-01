# Provider cassettes

A provider cassette is one scenario's real model-provider HTTP exchanges, recorded once and replayed byte for byte. On replay the real provider packages (`@openrouter/ai-sdk-provider`, `@ai-sdk/anthropic`, `@ai-sdk/openai`) parse what the provider actually sent; a hand-written emulator would only encode what we assume providers send.

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

## Replay matching

- The model-provider shim serves a cassette when its script is `{ cassette, substitutions, pace, settled }`.
- Each request claims the first unserved exchange recorded under the same key:
  - **Streamed or tool-offering:** knob, route, model, the conversation's first user message and its number of conversation items. The system prompt and tool definitions are not in the key; they are the host's to change.
  - **One-shot without tools:** model and order alone (how a thread title is matched).
- A request with no matching exchange is refused (`unrecorded-exchange`, naming its key and the keys still unserved). A lane fails on any refusal or unserved exchange.
- `pace: 1` replays recorded chunk times within each response.
- Concurrent conversations keep their recorded order by causality, not the clock: the lane passes `settled`, and a response's last chunk waits until every conversation the recording had finished by then has committed its end.
  - So background children finish before their parent's turn ends exactly as recorded, and the parent wakes the same number of times on any machine.

## Invariants and shape

- Each lane derives the settled conversation's shape and its violations:
  - the projection folds every row
  - a step's adjacent text blocks are one part
  - no tool row runs, and nothing streams, after `run.finished`
  - a delegation card's count equals its child's ledger
  - the first completed run's title commits before its `run.finished`
  - no tool result is the guard's generic `tool_failed` fault
- The shape names groups, row verbs and states, paragraphs per step, children and title timing.
  - One shape file per scenario, never text: `apps/desktop/src/__tests__/__snapshots__/provider-cassettes/<id>.shape.json`. Review its diff before committing.

## Record a scenario

Recording makes paid calls with the owner's keys. Agents never read, print or export a key, and never use the owner's main profile unless the owner approves it for that task.

- **Route 1: keys the owner exports.**
  - Export only the scenario's provider key (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`), then run `pnpm cassettes:record <scenario id|all>`. It records one scenario at a time and stops at the first failure.
  - Most scenarios record in the host lane. `openrouter-provider-error` records with a deliberately invalid key.
  - A scenario marked `recordedIn: 'desktop'` records in the desktop app, because the app sends what the standalone host never does (thinking disabled, its own tool set).
    - The wrapper builds the app and runs the desktop E2E in record mode with only the shell's basics and that one key, under `BRAINSTRIKE_PROVIDER_CASSETTE_RECORDER_KEY`. E2E global setup strips every inherited provider credential.
    - The test takes the key out of its environment before launch, so only the disposable profile's credential store holds it.
    - The recording must replay in the app to the same committed shape; the host lane then replays it for projection checks and writes its shape file. If either replay fails, the wrapper restores the old cassette.
  - To try a route offline, set `BRAINSTRIKE_PROVIDER_CASSETTE_UPSTREAMS` to a JSON object of knob to local stand-in base URL, as `cassettes:proxy --upstream` does.
- **Route 2: the app's own credentials.**
  - Run `pnpm cassettes:proxy --out <file.json>`, which prints the three base-URL knobs.
  - Start the dev app with those knobs, on a profile that holds keys and that the owner approved for this, and reproduce the scenario. Ctrl-C writes the capture.
  - The proxy only forwards the app's own headers. Use this for ad-hoc and desktop-only captures; a lane scenario replays reliably only when the app called the same tools the standalone host offers.
- Either route writes a cassette only if it passes four checks:
  1. Neither requests nor responses trip the secret scanner (`scripts/secret-scan.mjs`), and nothing holds the home directory (as a whole path) or the key.
     - A bare login isn't checked (`root` or `dev` can't be told from ordinary text).
     - Requests keep only protocol headers, never auth. A tool result in a request can carry a leaked key.
  2. It shows the behavior its scenario exists for (`exhibits`), e.g. GLM's empty-arguments tool frame.
  3. It keeps every invariant.
  4. It replays to the same shape: the host lane's shape for a host recording, or the committed shape in the app for a desktop recording.
  - The proxy applies check 1.
- Prompts name workspace-relative paths and pass no root, so a cassette replays in any workspace and both lanes.
  - A model that writes the disposable workspace path into a tool call fails check 4, because the replayed call targets a folder that no longer exists. Re-record, or tighten the prompt.

## Planned

- A cheap-model live canary that asserts invariants only and saves new shapes as cassettes.
- A debug-pack-to-fixture converter.
