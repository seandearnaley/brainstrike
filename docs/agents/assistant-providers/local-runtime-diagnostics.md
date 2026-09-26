# Local discovery and selection diagnostics

Supports `docs/agents/assistant-providers.md` § "AI ASSISTANT INTEGRATION".

BST-310, 2026-09-26: the app-state bridge/service seam owns discovery diagnostics;
services retain their existing detailed diagnostic policy. No inference behavior,
provider selection policy, CSP permission, or persistence store changes.

The existing `@brainstrike/logging` sink receives schema version 1 records under
`LocalRuntimeDiagnostics`. Probe/catalog attempts each emit a started record and
one result. Calls satisfied by a service cache are still attempts at this seam,
not claims of HTTP traffic. Disabled runtimes and automation overrides do not
pretend to issue requests. Native bridge and browser service are distinct routes.

| Code | Fields beyond code/schemaVersion |
| --- | --- |
| local_provider_probe_started | runtime, route |
| local_provider_probe_result | runtime, route, state |
| local_models_list_started | runtime, route |
| local_models_list_result | runtime, route, state |
| assistant_model_selected | provider |
| assistant_model_unavailable_shown | provider |

Runtime is ollama/lmstudio; route is native-bridge/browser-service. Result state
is the existing validated availability/catalog state or `error` on rejection.
Rejection identity and return values are unchanged. Events explicitly construct
fields: no response objects, raw errors, endpoints, credentials, or model IDs.
Selection means the preference action changed its validated composite key;
it does not claim a user gesture (reconciliation also uses the action).
Unavailable events mean a local model warning is the rendered panel notice, not
hidden by higher-priority discovery/memory notices. Re-render and Strict Mode
replay do not duplicate the same warning; clearing then showing it starts a new
warning episode. The model name stays private even though it identifies the
in-memory episode.

These are local logs, not outbound analytics. Starts and resolved outcomes use
info; rejected operations use warn. Existing log-level filtering still applies;
the durable diagnostic sink stores warn+ only, so normal events are session logs.

## Verification matrix

Automated in `packages/app-state/src/__tests__/local-runtime-diagnostics.test.ts`
and `packages/app-shell/src/__tests__/use-assistant-provider-disabled-reason.test.tsx`:

| Path | Evidence |
| --- | --- |
| Native bridge available/unavailable/blocked/auth/incompatible/stale | paired events, exact allowlisted payload |
| Browser service blocked by host capability | browser route and blocked_web result |
| Native catalog nonempty/empty/failed/stale | paired events without model data |
| Browser service catalog | browser route and empty outcome |
| Rejected probe/catalog and malformed native state | error outcome; rejection preserved |
| Disabled runtimes | no request events |
| Changed/repeated/invalid selection | one event for the valid change |
| Local warning shown/hidden/reshown, Strict Mode | one event per warning episode |
| Hosted provider warning | no local unavailable event |

These exercise real store/hook wiring with deterministic bridge/service doubles;
they do not claim a live Ollama/LM Studio server or a native Electron session.
For troubleshooting, filter Log Viewer by `LocalRuntimeDiagnostics` and the code.
A started record without a result means the attempt has not settled; unavailable
and blocked_web remain distinct. For endpoints/credentials use Settings' explicit
runtime diagnostics, not these bounded events.
