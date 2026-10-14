# Persona edits and admitted children — evidence

Supports `docs/agents/workspace-context.md` §
"Persona edits and admitted child decisions".
Read before changing how persona-file edits interact with already-admitted delegated children (BST-1727).

The record below is the prose that stood in the contract before it was
distilled to the contract/evidence idiom, extracted verbatim. The contract
holds the rules that are true today; where the two differ, the contract wins.

## Record

User persona scans resolve the profile for a fresh delegation. Once a child is
admitted, its effective tool scope, instructions, mode, model pin and clamped
step budget are stored with that delegated conversation. Editing, disabling or
removing the file affects fresh root turns, while pending child approvals and
questions resume with their admitted configuration, including after host reload.
Current host permissions and available model credentials still apply. Invalid
stored identity/configuration fails visibly rather than selecting a replacement
profile. Cross-provider credentials are resolved from the host on resume and
never written into the profile snapshot. No new persona store/reset registration
is added. Implementation and production evidence live in assistant-subagents.md's
admitted configuration section.

