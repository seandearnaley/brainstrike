# Collection inventory and binding admission

Collection admission owns one complete inventory through source loading, native publication,
strict full-manifest completion and workspace reverify. Its catalog ACKs reuse that same
inventory. Existing workspace passes and binding ACKs drain first; later workspace passes
wait before publication registration and native mutation. Queued work rejects source
retirement; running or failed physical ownership stays with the original source owner.

## Binding write-site inventory

The shared runtime has one physical `replaceFileBindings` site. Desktop main supplies
all of its authority and admits these callers:

| Phase / caller | Binding path | Ordering |
| --- | --- | --- |
| Startup, cold Pause, resume after source retirement | `runtime.acquire` before source admission | Existing saved-authority and physical retirement fences apply. |
| Collection iteration admission | Snapshot load, `runtime.acquire`, source loading | Reserve admission first, drain prior binding ACKs and complete workspace passes; retain one snapshot before native binding install. |
| Collection `loadAuthorizedBatch` / cache ACK | Shared catalog `replaceTrustedBindings` | Same actual request ID reuses the admitted snapshot without joining its own completion. |
| Workspace preflight `loadAuthorizedBatch` | Shared catalog ACK before `beginScan` | Later inventory/ACK waits for collection admission; ACK already in flight drains before collection capture. |
| Workspace preparation and cache writes | `prepareManagedSourcesBatch` / `applyManagedCacheBatch` ACK | Existing workspace request remains admitted while collection drains its entire pass; later workspace `beginScan` waits before pending publication registration. |
| Workspace native/PG removal | Publication removal, catalog `joinNativeRemoval`, PG cascade, shared ACK | Collection waits through the actual host's receipt, including the native removal that precedes catalog ACK. |
| `acquireRead` / joining `acquire` | Runtime reuse after catalog observation | Inventory capture gates reads until the admitted snapshot exists; identical reads use it, newer reads retain the existing queued reconciliation fence. |
| Collection verification, workspace reverify, queued iteration | Shared runtime authority callback | Snapshot remains retained through completion/reverify; the next iteration captures and installs the next inventory. |
| Pause, reconfiguration, root deletion, close/reset | Existing source/reader/writer retirement owner | Queued callbacks reject source abort; running work joins physically before retirement acknowledges. Original ACK capture and failed cleanup ownership remain unchanged. |

`completeFiles`, retained source reads and profile resolution do not replace bindings.
No host, utility protocol, native runtime, manifest predicate, readiness predicate or
retry policy is relaxed by this correction. The source inventory helper extracts the
existing bounded loading loop to keep activation within its existing file limit.

## Regression evidence

The retained loading test uses actual `CanonicalIngestionHost`, OXC parsing,
`CanonicalUtilityParent` / `CanonicalUtilityChild`, schema-checked structured-cloned
in-memory frames and the actual native writer/public manifest guard. PG queries and
retained-source persistence are controlled; this is not an Electron/app qualification.
The original `db302` production source rejects a second retained file arriving during
a held catalog batch ACK. Its unchanged inventory control succeeds. The corrected
source completes the original manifest and subsequently the latest full inventory.

Additional actual-host cases cover a held admission snapshot, an existing workspace
held after native finish but before its private-channel host receipt, and later workspace
inventory admission while collection loading remains held. Fixture cleanup joins both
actual workspace pass receipts and collection scan handles before retiring native owners.

Unit ownership cases use the actual publication adapter and controlled native operations:
workspace removal, prepared VECTOR work and abort remain owned until the physical pass
settles; original aggregate failure/cause is preserved; queued publication/ACK/read work
rejects retirement while running native work and failed admission retain their snapshot.
Existing actual missing-row and genuine native verification failure tests remain strict.
