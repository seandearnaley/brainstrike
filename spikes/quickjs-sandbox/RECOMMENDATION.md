# BST-1066 QuickJS-ng sandbox spike

## Recommendation

Use the engine and binding directly if Brainstrike continues with a QuickJS
backend: `quickjs-emscripten-core@0.32.0` plus
`@jitl/quickjs-ng-wasmfile-release-sync@0.32.0`. Do not add
`@sebastianwessel/quickjs` to the production dependency chain.

For Brainstrike's general JavaScript tool execution, keep the existing
`'fence'` backend as the default. A QuickJS `WasmExecutor` is promising as an
explicit, opt-in pure-JavaScript executor for small transforms where startup
latency and denial-by-default matter more than Node compatibility. It should
not silently replace a Node process, and it should not claim to implement the
current filesystem/network policy until those semantics are made explicit.

Confidence: **moderate (0.75)**. The engine-layer feasibility is proven here;
the product contract and threat-model fit are not yet strong enough for a
production recommendation.

## What the spike proved

- A fresh QuickJS runtime can apply a memory cap with `setMemoryLimit`.
- A deadline-backed interrupt handler stops `while (true) {}` and produces a
  distinguishable `timeout` result.
- A growing series of `ArrayBuffer` allocations fails with `out of memory` at
  the configured cap, after which a fresh runtime still executes normally.
- The guest has no ambient `fetch`, `XMLHttpRequest`, `WebSocket`, `require`,
  `process`, `fs`, `Buffer`, CommonJS `module`, or Emscripten `FS`/`MEMFS`/
  `NODEFS`. The `Function`-constructor escape attempt still resolves globals
  inside QuickJS and cannot find the host `process`.
- With no module loader installed, `import fs from "node:fs"` fails.
- An explicitly installed string function made with `context.newFunction` is
  callable and round-trips a value. The same name is `undefined` when it is not
  granted.

The selected package's installed README reports that it was built with
`-s FILESYSTEM=0`. The tests above establish the consequence at the guest
boundary: there is no Emscripten filesystem API in the QuickJS global object.
This does **not** mean the Node host process lacks filesystem access; the
variant loader itself necessarily loads the `.wasm` file. The boundary is
that guest code receives no bridge to that host capability.

## Dependency shape and ownership

There are three distinct ownership layers:

1. **Engine:** the `quickjs-ng/quickjs` organization owns the C engine. It has
   multiple active contributors and a regular upstream release stream. The
   installed variant vendors quickjs-ng **v0.12.1**; upstream has already
   published later versions, so Brainstrike must treat the binding's vendored
   version—not the upstream latest tag—as the code actually under review.
2. **Binding and generated variants:** Jake Teton-Landis's
   `justjake/quickjs-emscripten` repository owns
   `quickjs-emscripten-core`, the FFI, Emscripten build, and the `@jitl/*`
   variant packages. The installed packages are **0.32.0**. This layer still
   has meaningful maintainer concentration; direct use does not eliminate
   bus-factor risk.
3. **Wrapper:** Sebastian Wessel owns `@sebastianwessel/quickjs`. Its recent
   releases show active maintenance, but release contributions remain centered
   on one human maintainer. It adds virtual filesystems, fetch, Node shims,
   transpilation, worker pooling, and result conventions on top of the same
   binding.

The wrapper's conveniences are specifically the policy surface Brainstrike
needs to own and audit. Depending directly on the binding removes one
single-maintainer layer, reduces the trusted code and transitive feature
surface, and lets the `CodeExecutor` adapter define only the bridges it grants.
That is more valuable here than the wrapper's ergonomics. Pin both direct
packages together and test upgrades as a pair because the generated variant,
FFI, and core versions are coupled.

Sources checked for maintenance context on 2026-08-01:

- <https://github.com/quickjs-ng/quickjs/releases>
- <https://github.com/justjake/quickjs-emscripten>
- <https://github.com/sebastianwessel/quickjs/releases>

## Footprint

Measured locally with:

```sh
stat -f '%z %N' node_modules/@jitl/quickjs-ng-wasmfile-release-sync/dist/emscripten-module.wasm
```

Result: **528,551 bytes**, which is **516.16 KiB** (about **0.50 MiB**). This is
the raw WASM artifact only, not the binding JavaScript, FFI package, source
maps, package-manager metadata, or runtime heap.

## Contract fit: concrete `WasmExecutor` mapping

This section uses the provided `CodeExecutor` interface as the exact design
target. It does not import production code.

### Shape

A first `WasmExecutor` would cache the initialized `QuickJSWASMModule` and
create a **new `QuickJSRuntime` and `QuickJSContext` for every `execute` call**.
It would reject every language except `'javascript'`, set a fixed
executor-level memory cap, install the deadline interrupt handler, install only
the approved host functions, evaluate the code, bound all output buffers, and
dispose every handle/context/runtime with `Scope`.

Its advertised capabilities would be approximately:

```ts
{
  languages: ['javascript'],
  maxIsolationTier: 'vm',
  platform: process.platform,
  supportsNetwork: false,
}
```

`maxIsolationTier: 'vm'` is the only existing routing slot that can hold this
backend, but it is semantically lossy. QuickJS is a language VM in an in-process
WASM memory sandbox; it is not an operating-system virtual machine. If callers
currently interpret `'vm'` as a full workspace VM, this value overstates the
isolation boundary. The interface needs either documentation that the tier
includes an in-process language VM or a new capability dimension before this
ships. `platform` must also be validated as `'darwin'`, `'linux'`, or `'win32'`;
on any other Node platform the host should omit the factory instead of coercing
the value.

### Filesystem policy

For the first implementation, **do not add an in-memory virtual filesystem**.
Map the policy as follows:

- Empty `allowRead` and `allowWrite` lists are satisfied by absence: the guest
  has no filesystem capability at all.
- `denyRead` is vacuously enforced because all reads are denied. Its entries do
  not need a guest-visible mapping.
- Any non-empty `allowRead` or `allowWrite` must fail before evaluation with a
  visible `UnsupportedWasmPolicyError`. Treating an OS path as a virtual path,
  or silently ignoring a positive grant, would violate the caller's policy.
- `scratchDir` remains required by `ExecInput`, but is **not mounted or exposed**
  to QuickJS. It may be used only for host-side executor bookkeeping. If the
  caller expects guest scratch access, that request is unsupported and should
  be rejected through the non-empty write/read policy check.

This deliberately restrictive mapping is preferable to a `memfs` facade. An
in-memory store would not make `/real/path` refer to the OS resource named by
the existing policy, so it would look contract-compatible while changing the
meaning of the grant. A future virtual store should be a separately named
capability with its own namespace and quota contract.

There is no runtime downgrade: if the host advertises this factory in the
`vm` slot and construction or policy validation fails, `execute` fails. It
never falls back to `fence`.

### Network policy

With this spike's bridge set, only `allowedDomains: []` is supported and
`supportsNetwork` is `false`. A non-empty list must be rejected visibly; it is
not meaningful merely because it was passed to QuickJS.

If network is added later, the `fetch`-like function must live in the host-side
`WasmExecutor` adapter and be installed with `context.newFunction('fetch',
...)`. The guest never receives the host's native `fetch` object. That host
function must:

1. parse a guest-provided URL and allow only the intended schemes;
2. normalize the hostname and compare it to `policy.allowedDomains` using one
   precisely documented matching rule;
3. make the real request on the host only after the check;
4. disable automatic redirects or revalidate every redirect target;
5. enforce response-size and time limits; and
6. marshal a small inert response value back into QuickJS.

The sync WASM variant can expose a deferred guest promise, but the executor
must then drive pending QuickJS jobs and bound both halves of the asynchronous
operation. The QuickJS interrupt handler cannot preempt a blocking host
function, so every granted host callback must itself be bounded and
non-blocking. `allowedDomains` gates the host bridge; QuickJS has no network
stack for a proxy to intercept.

### Fields that do not translate cleanly

- **Memory:** `ExecInput` has no memory-limit field. A `WasmExecutor` therefore
  needs a documented host-configured fixed cap (as the spike uses) or a future
  contract extension. `timeoutMs` cannot double as a memory setting.
- **Timeout:** `timeoutMs` maps to a wall-clock deadline checked by the engine's
  interrupt callback. It is not an exact instruction counter and cannot stop a
  blocking host callback. Timeout maps to `timedOut: true` and a conventional
  non-zero `exitCode` such as 124.
- **Process result:** no process exits. Proposed mapping is `exitCode: 0` on
  clean evaluation, `1` on a guest/policy/bridge error, and `124` on timeout.
  These are adapter conventions, not QuickJS exit statuses.
- **stdout/stderr:** QuickJS has no Node `console` or process streams. The
  adapter would inject bounded `console.log`/`console.error` host functions and
  append their formatted arguments to executor-owned buffers. Uncaught guest
  exceptions go to `stderr`. Dropped output sets `truncated: true`. The final
  expression value should not silently become stdout; if Brainstrike wants
  expression results, that needs a separate convention because `ExecResult`
  has no value field.
- **scratchDir:** it has no guest-visible meaning with `FILESYSTEM=0`, as
  described above.
- **dispose:** each call disposes its runtime immediately. Executor `dispose()`
  marks the adapter unusable and releases host bridge state; the cached module
  API exposes no process to terminate.
- **Platform:** `platform` describes the host running WASM, not an OS visible
  inside the guest.

## Fence versus WASM

| Concern | OS fence + real Node | In-process QuickJS WASM |
| --- | --- | --- |
| Startup | Process startup and sandbox-runtime setup per execution | WASM module can be initialized once; runtime/context creation is in-process |
| Capability default | Node starts with a large API surface that the OS fence must constrain | No Node, filesystem, or network globals unless the adapter grants them |
| Failure containment | Process can be killed; OS boundary contains engine/process failure | Guest heap is bounded, but an engine/WASM/host-bridge bug shares Brainstrike's process |
| Compatibility | Real Node syntax, built-ins, npm packages, and OS-path semantics | QuickJS ECMAScript only; npm/Node APIs require custom loaders and shims |
| Policy fit | Direct fit for real paths, scratch directory, and proxied network domains | Current path/domain grants are unsupported without custom bridges |
| Operations | Process lifecycle, proxy, and platform-specific fencing | Handle disposal, marshalling, async job driving, bridge auditing, and engine-version tracking |

The passing allocation-bomb test proves that the selected build reports a
clean QuickJS `out of memory` error for that workload. It does not establish a
hard ceiling on total host RSS or rule out binding/engine defects. Because the
WASM instance shares Brainstrike's process, production threat modeling should
treat the memory limit as a guest-heap control, not equivalent to an OS process
memory limit.

The current `CodeExecutor` contract and likely agent workloads favor the fence:
they describe a real scratch directory, real path grants, real network policy,
and process-shaped output. QuickJS is a better capability sandbox for pure
compute, but rebuilding Node, filesystem, and network compatibility inside it
would erase much of its simplicity and expand the trusted bridge surface.

What would change the recommendation:

- telemetry showing most JavaScript executions are small, dependency-free
  transforms with empty filesystem/network grants;
- measured end-to-end latency showing process startup is materially harming
  the product;
- a revised executor contract that distinguishes OS files from virtual stores,
  distinguishes language-VM isolation from workspace-VM isolation, and exposes
  a memory budget;
- security review/fuzzing of the exact engine+binding version and a decision to
  run the WASM module in a worker or sacrificial process for host-process fault
  containment; or
- a requirement for Node/npm compatibility, which would reinforce the fence
  recommendation rather than QuickJS.
