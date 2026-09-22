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
