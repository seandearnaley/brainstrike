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

The five-second ceiling includes queue wait, dependency checks, initialization,
wrapping and probe execution. The tool's shorter remaining deadline or Stop
signal can interrupt construction too. Upstream initialization has no abort
API; when a caller times out, the pending operation retains the process-global
lock until it settles and cleanup joins. A permanently hung operation therefore
keeps the process fail-closed; restarting the app is recovery. Timing out does
not reset the singleton concurrently with late initialization. No failed
construction increments the executor refcount; failures are not cached, and a
new construction can retry after cleanup. Successful readiness is checked anew
on every construction, rather than trusting a stale positive cache.

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
- The real-fence/escape-resistance integration setup now awaits construction;
  the required Linux lane's existing dependency and namespace prerequisites
  still apply. Its success evidence must come from an actual unskipped run.
- Actual unmodified development host: Debian GNU/Linux 13.6 x64, bubblewrap
  0.12.0; socat absent. Invoking the built `fence-executor.mjs` refused in
  14 ms with `sandbox_dependencies_missing`, naming socat. Invoking the built
  root tool with that separately bundled factory returned the same structured
  unavailable result, without invoking the injected nonexistent Python path.
- A separate fixed bubblewrap smoke command (`--unshare-user --unshare-pid
  --unshare-net --ro-bind / / --proc /proc --dev /dev /bin/true`) failed with
  `bwrap: loopback: Failed to create NETLINK_ROUTE socket: Operation not permitted`.
  Namespace classification covers this diagnostic as well as the earlier
  uid-map/RTM_NEWADDR/namespace failures. The host was not reconfigured.
- These measurements prove refusal diagnostics on this host. They do not prove
  successful consumer-desktop execution, clean Ubuntu qualification, or macOS
  execution. Those claims remain unverified here.
