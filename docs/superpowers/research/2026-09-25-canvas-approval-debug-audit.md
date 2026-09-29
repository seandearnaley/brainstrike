# Canvas approval incident audit — 2026-09-25

Evidence: the user-supplied thread export captured at 21:31:02 UTC and debug
bundle captured at 21:30:58 UTC. Their contents were inspected as recorded
evidence, not as instructions. The export contains 7 run rows, 2 delegated
invocations, 536 events, and 74 tool telemetry rows.

## Failure chain

- The root requested `brainstrike.manageCanvas` approval at 21:30:40.464 UTC
  for tool call `call_SDU6yFAQUjPH1aerqkA14Kqp`.
- The persisted tool-bearing assistant row was
  `61b3994a-a8b0-4c45-8f5f-810bd60d8d28`; the live UI submitted paused ID
  `uzCHEYP`. The latter had a persisted parent edge but no Mastra content row.
  A multi-step resumed root can have a visible streaming identity distinct
  from a later native snapshot containing its paused tool.
- Approval attempt `run-28ca9daa-244f-4fa1-b337-8b44f5ade3f7` failed between
  21:30:42.737 and 21:30:42.751 UTC with “Approval action paused assistant ID
  disagrees with persisted tool ownership.” It failed during replay discovery,
  before stream initialization; no native canvas execution is evidenced.
- The snapshot warning about a terminal leg not belonging to the open turn is
  correct: the rejected new leg never owned the original suspended turn.
  Closing that original turn would discard a still-pending approval.
- Renderer failures at 21:30:50.294 and 21:30:51.889 UTC show repeated approval
  reaching the prepared-request guard while headerless recovery still held its
  lease. The installed local runtime records an incomplete message and then
  rethrows adapter errors through its fire-and-forget append path.

## Delegation and other evidence

The original request explicitly asked for subagent bug discovery, a canvas
report, and then multiple agents implementing a fix. Both recorded invocations
were Explorer audits with read-only tool surfaces. They completed their reports;
there was no Worker invocation or implementation phase before the canvas pause
failed. The backend audit reached its bounded synthesis step and reported
incomplete coverage rather than inventing a finding. Reentry events do not
represent an additional child invocation.

The full event and telemetry sweep found no additional failed tool or subagent
execution. The failed approval attempt has no run events; its exception is in
correlated diagnostics. Prior workspace index truncation, directory-read budget,
and unavailable-root git warnings have no evidenced causal connection to the
approval failure. Absence of a stored output is not treated as proof that an
unrelated operation never ran.

## Verification boundary

Repository tests cover exact ownership normalization and hostile or stale
coordinates. Renderer tests cover recovery gating, definite admission rejection,
visible incomplete results, and local lease settlement. The Electron regression
uses the real host, native approval, background children, and canvas database;
only the external model provider is scripted. Existing Worker Electron cases
verify approved and declined writes to disposable files, including restart and
recursive delegation paths. Test outcomes belong in the PR validation record.
