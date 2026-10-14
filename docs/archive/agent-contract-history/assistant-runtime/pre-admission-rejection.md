# Pre-admission rejection

Contract: `assistant-runtime.md` § "Renderer safety net".

On 2026-09-25, approving a paused `brainstrike_manageCanvas` call returned HTTP 500 before the host admitted the resume leg. The renderer treated every failed response without stream headers as ambiguous transport loss. It retained the prepared request while trying active-run discovery, so the approval card became retryable before that request was reconciled. A second click reached the prepared-request guard and raised `Cannot start a hosted assistant run while another run is in progress.` The installed local runtime's fire-and-forget append also surfaced its rethrown error as an unhandled rejection.

The host now marks only a proven pre-admission action failure with `error: "assistant_admission_rejected"`. The adapter reports it through `onError` and returns an incomplete error result to the local runtime. The renderer awaits completion of the newly prepared run before releasing its local lease. A completion write failure remains visible and retryable through the recovery control, using the original completion callback. Generic HTTP 500 responses retain discovery and the guard because the host may have admitted the run before the transport failed. The original paused run is never completed by this recovery path.

The approval, suspend, question, plan and category-grant controls remain disabled while reconciliation or rejected-run completion is pending. Tests cover the real local-runtime append result, classification, deferred completion, failed completion retry and decision controls.
