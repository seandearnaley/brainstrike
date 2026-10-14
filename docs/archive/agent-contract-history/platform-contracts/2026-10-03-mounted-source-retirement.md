# Joined mounted-source and watcher retirement

Main borrows narrow canonical source operations from its actual mounted-root registry and awaits filesystem retirement before inference hosts and database shutdown. The source borrow never opens another root, and visible close does not retire a utility borrow sharing the same native producer.

## Ownership

The borrow captures the exact mounted object, durable root ID and generation. Strict root-relative path and native byte/entry bounds apply before reads; cancellation and current mount identity are checked after actual native work settles. Remove, replacement and registry disposal join borrows before closing mounted handles. A failed unsubscribe remains reachable for explicit retry, including a typed late-acquisition retirement owner.

One Parcel producer is shared by subscriptions on the same mounted object. Manual retry joins the previous producer before replacement, keeps logical subscribers, suppresses callbacks across the gap and signals overflow for reconciliation. Independent startup/cleanup failures stay visible. New subscriptions cannot enter a retiring or retrying owner.

Visible watch acquisition and final unwatch await their native ownership boundary. A failed final unwatch retains its logical ID and capacity until an explicit retry succeeds. Application/domain close attempts independent unregister and physical cleanup branches and reports every failure after settlement. The actual main `file-system` graceful step awaits this same resource before host/database retirement; late synchronous IPC bookkeeping does not prove physical completion. Existing forced-exit/database-close budgets remain unchanged.

## Validation record

Causal RED controls covered held acquisition/unsubscribe, stale mount/authority, typed rejected-acquisition cleanup, manual shared retry and disposal, the missing graceful filesystem step, independent unregister failure, failed final-unwatch retry and throwing domain handler removal. Each was corrected without weakening assertions or adding a fallback.

Final focused unit verification includes actual main factory/shutdown wiring, shared native owner and lease races, existing registry/IPC behavior, and synchronous disposer ledger guards. Actual native tests cover original bytes, enforced byte limits, honest directory truncation, symlink rejection and path-swapped replacement refusal. Public package prerequisites are built through the ordinary desktop dependency closure; normal commit hooks run unchanged.

Earlier combined test attempts and their failure attribution remain preserved in the delivery record; an interrupted or failed run is not reported green. Logs use the `/tmp/m2-main-*` paths listed in the composition handoff.

This layer enables canonical utility attachment to the existing application roots. It does not activate the utility/index runtime, replace visible producers, complete factory reset, or qualify actual Electron/model/GPU behavior, closed-window lifetime, performance or full M2 acceptance. No persistent state or wire protocol was added.
