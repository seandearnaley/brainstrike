# Embedding host disposal and desktop test teardown — evidence

Supports `docs/agents/local-inference.md` § "Embedding host lifecycle and
shutdown". Read before changing disposal during `starting`, the Stop
acknowledgement bound, or Playwright window teardown. Verified 2026-09-21:
`EMBEDDING_HOST_SHUTDOWN_TIMEOUT_MS = 3000` in
`apps/desktop/src/embedding-host-manager.ts`.

## Original text

Disposing an embedding host during `starting` cancels its lifecycle directly:
the renderer may still be awaiting DB setup and have no command listener yet.
Do not send Stop and wait for its acknowledgement in that state. The existing
lifecycle disposal destroys the owned window and rejects startup/status waiters;
a running host still uses its normal worker Stop protocol with a 3s acknowledgement
bound inside the application's unchanged 5s shutdown deadline. Missing acknowledgement
or an explicit renderer error destroys the owned renderer and remains a reported
stop failure. Manager/lifecycle
unit tests and the delegated worker's real restart test cover this boundary;
the latter requires both Electron processes to exit cleanly with code zero.

Desktop test teardown requests application quit while hidden host windows still
exist. Do not pre-close every Playwright window: removing hidden renderer command
listeners before the main shutdown coordinator drains owners races Stop acknowledgements.
Foreground child decision coverage asserts actual process exit zero as well as UI success.

## Active embedding requests during Stop (2026-09-26)

The controller previously aborted admission and idle waits but did not pass its Stop
signal to a hosted provider's active `embed` request or to the dedicated local
streaming worker. Its loop join could therefore outlive the host's 3s Stop bound.
The active hosted and local streaming PGlite job tests block inference until the
signal arrives, prove prompt Stop, and verify the claimed job remains `running`
with one attempt. The streaming client tests prove that aborting either an active
or queued stream terminates its dedicated worker immediately and rejects the active
and queued promises with the exact signal reason, including when the queued signal
was already aborted. A later worker reclaims the durable lease with a new claim
that increments `attempts`; Stop itself records no additional failure settlement.
Cancellation is recognized only when the failed request carries the exact Stop
signal reason through the provider or streaming client. A separate provider
failure arriving after Stop still records its normal queue failure and retry.
The six hosted provider variants (OpenAI, Ollama, LM Studio, Cohere, Google,
Voyage) have a fetch contract test proving that an active abort keeps the exact
signal reason in `network_error.originalError`.
The real Electron regression `embedding-host-active-stop.desktop.test.ts` held an
Ollama-compatible HTTP embedding request open while the hidden renderer was
running. The Stop bridge returned a `stopped` status with a command-prefixed
ID within 3s, the request socket closed, and the job retained its first running
lease. Manager unit tests separately reject a different command ID and accept
the ID sent with Stop.
The 2026-09-26 run passed 1/1; its subsequent app shutdown reported a 6ms
embedding-host step after explicit Stop. This proves active hosted Stop, not
model initialization or a still-active request during app quit.
