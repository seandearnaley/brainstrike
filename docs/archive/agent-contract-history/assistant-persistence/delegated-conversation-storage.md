# Delegated conversation identity storage — evidence

Supports `docs/agents/assistant-persistence.md` §
"Delegated conversation identity storage". Read this before proposing to change the graph walk, node immutability, or the workspace binding capture.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

`@brainstrike/db` exposes `createDelegatedConversationRepository` over a minimal
query interface for trusted host use. Register the real root, then bind each
actual native child thread beneath its immediate parent. Write inputs must come
from the host's observed native delegation context, never model-supplied ids or
renderer requests. A native resource id is execution scope, not user authority.

Every read and child creation walks the persisted graph outward from the live,
authorized root and verifies each native thread/resource pair. A grandchild
whose intermediate ancestor changes native scope is inaccessible even if the
grandchild's own row still matches. The authenticated host supplies root owner
and root id; these query methods are not unauthenticated endpoints. Missing
legacy graph nodes return no identity and do not fabricate transcripts or
ancestry from compact tool results.

Nodes are immutable: duplicate creation with the same configuration is
idempotent, conflicting ownership/ancestry/configuration is an error, and two
calls to one persona use distinct native thread ids. Display name/color are
host-assigned identity snapshots; this foundation does not yet implement their
UI or rename controls. Workspace binding is captured when the child is created;
existing children and their descendants retain that binding after the root's
workspace changes. See `database.md` for migration/reset/deletion semantics.

This storage foundation does not change production runtime behavior or usage
writers. Migration 127 now provides invocation/run binding records (see database.md).
BST-1718 still needs lifecycle and exact usage reconciliation, authenticated
host wiring, resume hydration, and complete native branch deletion. Full child message persistence/rendering remains BST-1719.

