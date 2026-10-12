# Native Pause retains authoritative reads

Pause suspends canonical ingestion while retaining the current native reader and
its actual store, profile, scope and mounted-root authority. Enabled continues to
control whether that capability can bootstrap. Neither engine readiness nor
native counts establish a complete source scan.

The first production activation collapsed `enabled && !paused` and routed every
saved-settings change through terminal source and writer retirement. Cold-paused
status therefore refused reader startup; warm Pause destroyed read ownership.
This differed from the existing visible Workspace Index Pause semantics and
prevented the qualification harness from measuring its unchanged cold paused idle
phase before the actual canonical pipeline resumes.

The correction keeps the original graph/read controller and publication proofs,
and gives ingestion separate controllers, attachments, inference operations and
root borrows. The utility parent retires an attachment's actual source borrow, so
reader authority must have a separate original borrow. Cold Pause only bootstraps
actual saved authority, full bindings, writer/reader and incomplete publication
state. It does not attach a canonical source or subscribe to a watcher. Resume
constructs the existing pipeline with the exact saved TEXT/VECTOR choice.

`IndexerHostManager.retireCanonicalSources()` delegates to nonterminal
`CanonicalUtilityParent.retireAttachments()`. The parent owns sessions before a
public attachment handle returns, so activation cannot safely acknowledge Pause
by closing only returned handles. The API fences attachment admission
synchronously, joins retained acquisition and physical source cleanup through the
original `closeOwner`, retains cleanup failures and the fence for explicit retry,
and admits fresh sources only after success. Terminal close remains terminal and
cannot be reopened by an overlapping nonterminal retirement.

Paused read acquisition still observes actual PG inventory, invalidates changed
collection/workspace proofs and reconciles trusted native bindings. It never
schedules a parser, document inference, scan or watcher. Unchanged complete proofs
remain attached to their original graph/store; interrupted scans remain incomplete.
Reset, root/collection/profile reconfiguration and shutdown retain their original
terminal retirement paths.

Causal tests first reproduced six failing pause/settings guards and four failing
owner-API guards on the composed baseline. Paired guards exercise cold status,
coverage and killable grep; saved VECTOR plan with no document work; retained warm
reads and cleanup authority; physical scan/inference joins; distinct root-borrow
retirement; catalog changes without ingestion; failed cleanup/retry/reset; held
acquisition; and terminal close races. Logs and exact-head results belong to the
composition owner's delivery evidence. Focused tests do not qualify actual app,
performance, inference throughput or other platforms.

The preserved qualification corpus, instruments, thresholds and cold state are
unchanged. No prebuild/rebuild baseline substitution or application/GPU campaign
is part of this correction.
