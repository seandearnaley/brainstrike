# Deleted file acknowledgement ordering

Invalidation fences a file for its existing scan lifetime. TEXT and VECTOR commits recheck that fence after their physical acknowledgement, before installing any cached plan. A new scan clears the fence only after the existing pending-work admission guard permits replacement.

The bounded b612 review found an admitted commit could acknowledge after cache invalidation but before native removal, restoring a cached plan for a physically deleted row. Its immutable production-class/controlled-writer probe is recorded in `delivery/native-delete-reconciliation-b612-review-evidence.md`; that probe was not actual app/native-engine evidence. The process core and synchronous writer worker permit the commit-before-removal FIFO ordering.

Controlled TEXT/VECTOR guards reproduce that exact late acknowledgement and require visible invalidation rejection, a missing cached manifest and refusal of further old-ticket writes. A separate public/native TEXT fixture delays delivery of a real commit acknowledgement, invalidates the file, delivers the commit and joins actual deletion. It then restores the same identity/hash, proves both cached and actual native manifests missing, republishes through a new scan and verifies the real native full manifest/complete receipt. The previous two deletion-order native cases preserve other rootless and full-profile data.

The correction adds only a per-scan invalidated-ID set to the existing publication owner. There is no duplicate controller, runtime API change, guessed second invalidation, manifest relaxation or fallback. The actual product app campaign remains separately held for independent review and qualifier rerun.
