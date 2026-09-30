# Construction-time fence readiness

Supports `docs/agents/code-execution.md` § "FenceExecutor" and the two-mode resolution contract.

## BST-1317: the dependency check was insufficient

The original factory advertised `os-fence` after an OS/runtime allow-list
check. Initialization waited until the first user script, so a host with
installed binaries but blocked Linux namespaces looked supported until its
script returned bubblewrap's nonzero exit. Readiness now rejects construction
before the caller receives an executor.

Construction is asynchronous through the existing seam. Every construction
runs a fixed `printf` shell builtin through sandbox-runtime's real wrapper,
with the same offline policy mapping, environment allow-list, process-group
teardown and a temporary scratch directory. Python is not invoked or checked
by this probe. Successful exit and the exact fixed marker are both required.
A missing seccomp component is also a refusal: sandbox-runtime reports it as a
warning, but running the probe without that layer would prove a weaker fence.
All dependency warnings fail closed; the bounded actual warning is included
in the diagnostic rather than assuming every warning concerns seccomp.

The five-second probe ceiling starts after acquiring the global lock and covers
dependency checks, initialization, wrapping and probe execution. Queue wait is
bounded by the caller's tool deadline or Stop signal, so a concurrent long
execution cannot falsely diagnose the host as unready. Upstream initialization has no abort
API; when a caller times out, the pending operation retains the process-global
lock until it settles and cleanup joins. A permanently hung operation therefore
keeps the process fail-closed; restarting the app is recovery. Timing out does
not reset the singleton concurrently with late initialization. No failed
construction retains an executor refcount; an abort that wins the handoff race
releases any late successful lease under the lock. Failures are not cached, and
a new construction can retry after cleanup. Successful readiness is checked
anew on every construction: the added probe latency deliberately avoids trusting
a stale positive result when host permissions or dependencies have changed.
Cleanup failures preserve the primary typed reason and aggregate both errors
for diagnostics. A successful probe with failed cleanup still fails closed.
Late probe/cleanup failures are logged before rethrowing the original caller
cancellation reason. Aggregate members are logged explicitly so error lists
survive log redaction.

Missing dependencies, namespace denial, unsupported/degraded runtime, timeout
and unexpected failure have separate typed unavailable reasons. Detail reaches
the existing run_python result card. The predicate is structural because the
root/tool and fence-executor entries are independently bundled; `instanceof`
alone would lose the typed reason in the shipped app. Python's `python_*`
errors remain `interpreter_unavailable`. No fallback, security setting change,
AppArmor/sysctl workaround, or Electron sandbox relaxation is introduced.

## Verification record, 2026-09-30

- Regression tests first failed at the missing wrapped probe and missing typed
  refusals, then passed with construction gating. Unit tests cover successful
  construction, unavailable dependencies, namespace denial, unavailable
  seccomp, timeout in initialization/wrapping, cancellation, late cleanup,
  refcounts, retry, no script execution, no fallback and the bundle boundary.
- Review regressions cover construction queued behind a six-second execution,
  caller cancellation while queued, the microtask handoff window, an unrelated
  dependency warning, and simultaneous probe/cleanup failures. The UI keeps
  actionable backend detail once, using curated remediation only as a fallback.
- A live sentinel across the microtask sweep pins exactly-once release: no
  reset while it is live, then one reset on its disposal. A double-decrement
  control fails this assertion. Real log listeners capture late failure details
  after Stop/timeout while the caller retains the original reason object. UI
  fixtures include current backend wording, including safe fallback negations.
- Vitest 5.0.2 defaults to `clearMocks: true`; module state deliberately remains
  intact so leaked leases break lifecycle assertions. `realpath.native` is
  retained per the seam's OS-canonical path contract.
- The real-fence/escape-resistance integration setup now awaits construction;
  the required Linux lane's existing dependency and namespace prerequisites
  still apply. Its success evidence must come from an actual unskipped run.
- Measured through the exec-command sandbox on Debian GNU/Linux 13.6 x64, bubblewrap
  0.12.0; socat absent. Invoking the built `fence-executor.mjs` refused in
  14 ms with `sandbox_dependencies_missing`, naming socat. Invoking the built
  root tool with that separately bundled factory returned the same structured
  unavailable result, without invoking the injected nonexistent Python path.
- A separate fixed bubblewrap smoke command (`--unshare-user --unshare-pid
  --unshare-net --ro-bind / / --proc /proc --dev /dev /bin/true`) failed with
  `bwrap: loopback: Failed to create NETLINK_ROUTE socket: Operation not permitted`.
  Namespace classification covers this diagnostic as well as the earlier
  uid-map/RTM_NEWADDR/namespace failures. The host was not reconfigured; this
  result does not characterize the separate native desktop execution route.
- These measurements prove refusal diagnostics in that execution context. They do not prove
  successful consumer-desktop execution, clean Ubuntu qualification, or macOS
  execution. Those claims remain unverified here.
