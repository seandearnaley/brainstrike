# Background context order

Supports `assistant-subagents.md` § "Background worker execution and pending controls".

The 2026-09-27 working-memory loop exposed background context re-dated as a fresh
user message after every tool result. Anchor the current context to the owning user
input using public MessageList APIs; retain that input timestamp across pruning.
New outcomes remain refreshed before the token limiter. Tests cover changing task
states, lost context, initial/continuation turns, memory writes and final output.
See `../assistant-runtime/approval-history-and-memory-context.md` for the incident.
