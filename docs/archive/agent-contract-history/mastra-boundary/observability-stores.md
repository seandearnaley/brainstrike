# R8 observability stores — evidence

Supports `docs/agents/mastra-boundary.md` § "R8 OBSERVABILITY AND EVALS". Read
this before proposing `@mastra/observability` or adding a fifth store.


**Brainstrike Pino logs, durable run events, the usage ledger, and diagnostic
events remain the observability source of truth. `@mastra/observability` is not
adopted.**

Four stores, contractually separate:

| Store | Scope | Retention |
| --- | --- | --- |
| `brainstrike_assistant_run_events` | run | thread cascade |
| `brainstrike_diagnostic_events` (Flight Recorder P1) | app-wide, warn+ | 30d / 20k rows |
| `brainstrike_assistant_run_usage` | billing fact, no FK | unbounded by design |
| Pino → `brainstrike.log` | process | file rotation |

Run-event metadata is redacted by denial-list at construction *and* at both write
sites (`packages/assistant-contract/src/run-events.ts:104-138`, `:164-214`). The
tool-lifecycle bridge builds metadata from scratch with four keys only
(`mastra-chunk-decoding.ts` `makeToolEventMetadata`, plus the delegation
builder in `tool-lifecycle-processors.ts`), so raw args, results, and error text never reach a
durable row.

Adopting `@mastra/observability` would add a second exporter topology over the same
events with no consumer. Also note a silent-degradation trap: passing a config
*object* to `observability` instead of an `Observability` *instance* logs a warning
and disables observability **entirely**.

