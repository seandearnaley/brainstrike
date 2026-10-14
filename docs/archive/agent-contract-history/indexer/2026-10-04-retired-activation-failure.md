# Retired activation failure ownership

Retire generation failure state only after its source/read/writer/profile owners
join successfully. Keep activation admission closed through replacement
preparation and preserve a replacement acquisition failure as the new fatal cause.

The application campaign on `a62a9ea5` recorded a failing `indexSearch.status`
whose closed-admission error carried the initial missing-mode startup cause,
after a saved TEXT choice had been observed. The packet does not log profile
acquisition timing or prove the initiating callback.

The connected regression uses actual activation/runtime ownership, settings-write
IPC, serialized configuration transitions, public status and status IPC. It first
fails startup without an explicit mode, persists collection/policy choices that
remain incomplete, then persists TEXT and holds the real profile-acquisition
dependency. Old owners have joined, but runtime resume previously reopened reads
before the activation cleared its closed flag and retained startup error. Status
therefore reached the deliberate fatal-cause admission guard. The same held
acquisition after clean startup returned unavailable; releasing either acquisition
recovered TEXT without inference.

Close and destroy now share a reset after successful profile retirement. Resume
does not clear historical failure after reopening runtime reads; it records a
replacement acquisition failure instead. This changes ownership ordering, not
error classification, IPC, publication progress or renderer execution identity.

RED controls cover held acquisition through reconfigure, rebuild and explicit
resume, the connected settings/status IPC path, and replacement failure cause
identity. GREEN controls retain old writer/profile join ordering, failed cleanup
and same-owner retry, fatal malformed preferences, new acquisition failure and
strict raw admission. The resource dependencies are gated test ports; this is
causal lifecycle evidence, not application, native-process or performance
qualification. The actual campaign timing remains unproven.

Guards: `apps/desktop/src/__tests__/native-authority-observation.test.ts`,
`native-index-activation.test.ts`, `native-index-runtime.test.ts`,
`native-scoped-search.test.ts`.
