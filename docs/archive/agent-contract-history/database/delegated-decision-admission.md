# Delegated decision admission — evidence

Supports `docs/agents/database.md` § "Delegated decision admission".

Migration 131's decision table: leaf uniqueness, the single rollback exception, startup reaping semantics, and `original_tool_call`. Read before changing decision claim lifecycle.

The record below is the original contract text, extracted unchanged.

Startup reaping runs only after database migrations complete. Its decision-state
update intentionally fails on an unmigrated schema; optional-relation cleanup
is reserved for reset, not startup recovery.

`brainstrike_delegated_tool_decisions` records host admission of an exact
root-owned native leaf run/call. Its permanent leaf uniqueness rejects repeat
answers; a partial unique root index excludes concurrent claimed resume legs.
The owning runtime alone settles its claims to consumed. The sole exception is
failure of the native snapshot recheck before any native resume invocation:
the owning binding deletes only its matching unexecuted claim, allowing a
fresh validation attempt. Other hosts cannot roll it back, and a consumed or
interrupted decision cannot be reopened. Cancellation or failure after native
invocation retains the decision because the effect may already have occurred.
Startup reaping marks
claims from terminal abandoned hosts interrupted, retaining their identity and
releasing root admission. Neither state asserts whether a side effect occurred.
Native Mastra snapshots remain execution authority, and an interrupted record
is never a replay instruction. The table references the owned conversation,
original invocation and host leg; complete branch deletion cascades it. Host
retention must preserve resumable invocation branches as already required.

The same migration adds nullable `original_tool_call` to delegated invocations.
Fresh native calls capture the model input before delegation, and repeated
invocation publication must match it exactly. Legacy null remains unknown;
approval resume cannot substitute the forwarded leaf input. The decision table
is in the reset registry and all explicit clear paths. Migration replay, real
host admission, immutable input and reset coverage tests protect these rules.
