# BST-1237 v3 Canonical Native Capability Contract — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PR #2418 with a version whose native capability contract is canonical: handle-derived identity, drain-based revocation, no per-root I/O serialization, truncation as a visible partial result, plus the four registry review-finding fixes.

**Architecture:** Import #2418's tree as a baseline commit on `claude/bst-1237-canonical-capability` (cut from `main`), then redesign in layers: native addon first (identity + revocation), then `WorkspaceRootRegistry` (mount-then-ask, dedup, quarantine), then the truncation pseudo-node through the explorer, then deletions/cleanups, then docs + full gate + PR.

**Tech Stack:** Node-API C++ addon (`node-gyp`), TypeScript strict (never `any`), Electron main-process IPC, React 19 renderer, Vitest, `node:test` for the native suite, pnpm/Turborepo.

**Worktree:** `/private/tmp/brainstrike-bst-1237-v3` on branch `claude/bst-1237-canonical-capability` (based on `origin/main` @ `558832c58`). The superseded PR branch is checked out at `/private/tmp/brainstrike-bst-1237` for reference only — never edit it.

**Spec:** `docs/superpowers/specs/2026-08-12-bst-1237-canonical-capability-design.md` (in this worktree).

## Global Constraints

- TypeScript strict; never `any` — use `unknown` + narrowing. Filenames kebab-case.
- NO SILENT FALLBACKS: malformed config/state throws or surfaces visibly; never coerce.
- Biome/ultracite: run `pnpm dlx ultracite fix` before each commit (2-pass check→format; props sorted alphabetically; block statements).
- Native addon packages stay `node-gyp` builds; `packages/secure-fs-native` turbo caching is `cache:false` (do not change).
- Native read cap is `16 * 1024 * 1024` bytes; `listDir` max entries bound is `10_000` (`MAX_DIRECTORY_ENTRIES`).
- Root paths come only from the trusted folder picker / persisted store — following symlinks is allowed **only** when opening the root itself; descendant resolution stays strictly no-follow.
- The bar per task: relevant package build + lint + type-check + unit tests green in the same run. Full workspace gate in Task 9.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Never edit files under `/private/tmp/brainstrike-bst-1237` (reference checkout of #2418).

---

### Task 0: Import the #2418 baseline

**Files:**
- Modify: entire tree (23 files, +2070/−1899 vs `main`) via `git read-tree`
- Preserve: `docs/superpowers/` (spec + this plan exist only on this branch)

**Interfaces:**
- Consumes: `origin/codex/bst-1237-root-registry` (commit `d0aa34ee6`)
- Produces: a working tree identical to #2418 plus `docs/superpowers/`, as one commit on this branch. All later tasks edit these files.

- [ ] **Step 1: Import the tree, keeping docs/superpowers**

```bash
cd /private/tmp/brainstrike-bst-1237-v3
git read-tree --reset -u origin/codex/bst-1237-root-registry
git checkout HEAD -- docs/superpowers
git add -A
```

- [ ] **Step 2: Verify the import is exact (modulo docs/superpowers)**

```bash
git diff --cached origin/codex/bst-1237-root-registry -- ':!docs/superpowers' | head
```
Expected: empty output.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(desktop): import #2418 workspace root authority baseline

Baseline for the BST-1237 v3 canonical-capability redesign; supersedes
PR #2418 without carrying a review patch stack.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Sanity-build the native addon and run its suite**

```bash
pnpm --filter @brainstrike/secure-fs-native build && pnpm --filter @brainstrike/secure-fs-native test
```
Expected: 12 tests pass (the #2418 baseline is green).

---

### Task 1: Native identity — open-then-derive

**Files:**
- Modify: `packages/secure-fs-native/src/secure_fs.cc` (root open at `OpenAbsoluteDirectory`, both platforms; new `DeriveCanonicalPath`; `SecureRoot` constructor + new `canonicalPath` instance method; delete `ParseWindowsAbsoluteRoot`)
- Modify: `packages/secure-fs-native/index.cjs` (drop `realpathSync`; cache native-derived path behind a getter)
- Modify: `packages/secure-fs-native/index.d.ts` (no shape change — `readonly canonicalPath: string` becomes honest; add a doc comment)
- Test: `packages/secure-fs-native/test/secure-root.test.cjs`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `new SecureRoot(requestedPath: string)` where `requestedPath` may contain symlinked components (root open follows them); `secureRoot.canonicalPath: string` is derived from the opened handle. Task 3's registry relies on exactly this: `createSecureRoot(entry.path)` works for non-canonical presentation paths.

- [ ] **Step 1: Write the failing test (symlinked root input resolves via the handle)**

Append to `packages/secure-fs-native/test/secure-root.test.cjs` (uses the existing `fixture()` helper and `cleanupPaths` from the file's prelude; `symlinkSync`/`realpathSync` are already imported at the top — if `symlinkSync` is missing from the `require('node:fs')` list, add it):

```js
test('derives canonical identity from the opened handle for a symlinked root path', () => {
  const { workspace } = fixture();
  const alias = path.join(tmpdir(), `bst-secure-root-alias-${process.pid}-${Date.now()}`);
  symlinkSync(workspace, alias, 'dir');
  cleanupPaths.push(alias);
  const root = new SecureRoot(alias);
  try {
    // Identity must come from the pinned handle: the symlink alias resolves
    // to the workspace's canonical path, not to the alias string.
    assert.equal(root.canonicalPath, realpathSync.native(workspace));
    const listing = root.listDir('.', 100);
    assert.ok(listing);
    assert.ok(listing.entries.some((entry) => entry.name === '.brainstrike'));
  } finally {
    root.close();
  }
});
```

Note: if the file tracks temp dirs differently (check the `afterEach` at the top of the file), register `alias` for cleanup the same way the other tests do.

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @brainstrike/secure-fs-native test
```
Expected: the new test FAILS — the baseline walks the alias path with `O_NOFOLLOW` (POSIX) so the constructor throws `Failed to open secure filesystem root` (the JS wrapper's `realpathSync` used to hide this; it is proof the wrapper, not the capability, owned identity).

Wait — on the baseline the wrapper still calls `realpathSync` first, so this test may PASS. If it passes, temporarily verify the flaw the honest way: the failing property is that `NativeSecureRoot` cannot take a symlinked path itself. Keep the test AND change `index.cjs` first (Step 3a) so the wrapper no longer pre-resolves; then the test fails RED against the unchanged C++. Run order: Step 3a → Step 2 (RED) → Step 3b (C++) → Step 4 (GREEN).

- [ ] **Step 3a: Rewrite the JS wrapper as a passthrough (this creates the RED state)**

Replace `packages/secure-fs-native/index.cjs` entirely:

```js
'use strict';

const bindings = require('bindings');

const { SecureRoot: NativeSecureRoot } = bindings({
  bindings: 'secure_fs_native',
  ['module_root']: __dirname,
});

class SecureRoot {
  #canonicalPath;
  #native;

  constructor(rootPath) {
    // The native layer is the only resolver: it opens the root (following
    // symlinks for root establishment only) and derives canonical identity
    // from the opened handle. No path-based pre-resolution happens here.
    this.#native = new NativeSecureRoot(rootPath);
    this.#canonicalPath = this.#native.canonicalPath();
  }

  get canonicalPath() {
    return this.#canonicalPath;
  }

  close() {
    this.#native.close();
  }

  listDir(relativePath, maxEntries) {
    return this.#native.listDir(relativePath, maxEntries);
  }

  listDirAsync(relativePath, maxEntries) {
    return this.#native.listDirAsync(relativePath, maxEntries);
  }

  readFile(relativePath, maxBytes) {
    return this.#native.readFile(relativePath, maxBytes);
  }

  readFileAsync(relativePath, maxBytes) {
    return this.#native.readFileAsync(relativePath, maxBytes);
  }
}

exports.SecureRoot = SecureRoot;
```

Run `pnpm --filter @brainstrike/secure-fs-native test` — expected: new test (and possibly others on macOS where `tmpdir()` is under the `/tmp` symlink) FAIL with `canonicalPath is not a function` / open failure. This is the RED state.

- [ ] **Step 3b: Implement open-then-derive in `secure_fs.cc`**

(1) Replace the POSIX `OpenAbsoluteDirectory` (currently the component walk at lines ~457-480) with a follow-permitted single open:

```cpp
NativeHandle OpenAbsoluteDirectory(const std::string& path) {
  if (path.empty() || path.front() != '/' || path.find('\0') != std::string::npos) {
    return kInvalidHandle;
  }
  // Root establishment follows symlinks by design: the path comes from the
  // trusted folder picker or persisted store, never from repository content.
  // Descendant resolution below this handle remains strictly no-follow.
  return open(path.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
}
```

(2) Replace the Windows `OpenAbsoluteDirectory` (and delete the now-unused `ParseWindowsAbsoluteRoot`) with:

```cpp
NativeHandle OpenAbsoluteDirectory(const std::string& utf8_path) {
  const std::wstring path = Utf8ToWide(utf8_path);
  if (path.empty()) {
    return kInvalidHandle;
  }
  const NativeHandle handle = CreateFileW(
      path.c_str(),
      FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  if (handle == kInvalidHandle) {
    return kInvalidHandle;
  }
  // Without FILE_FLAG_OPEN_REPARSE_POINT the open resolved any reparse points;
  // the final object must be a plain directory.
  FILE_BASIC_INFO info{};
  if (!GetFileInformationByHandleEx(handle, FileBasicInfo, &info, sizeof(info)) ||
      (info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    CloseNativeHandle(handle);
    return kInvalidHandle;
  }
  return handle;
}
```

(3) Add `DeriveCanonicalPath` per platform (place next to each platform's `OpenAbsoluteDirectory`):

```cpp
#ifdef _WIN32
std::string DeriveCanonicalPath(NativeHandle handle) {
  std::wstring buffer(512, L'\0');
  for (;;) {
    const DWORD length = GetFinalPathNameByHandleW(
        handle, buffer.data(), static_cast<DWORD>(buffer.size()),
        FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (length == 0) {
      return {};
    }
    if (length < buffer.size()) {
      buffer.resize(length);
      break;
    }
    buffer.resize(static_cast<size_t>(length) + 1);
  }
  if (buffer.rfind(L"\\\\?\\UNC\\", 0) == 0) {
    buffer = L"\\\\" + buffer.substr(8);
  } else if (buffer.rfind(L"\\\\?\\", 0) == 0) {
    buffer = buffer.substr(4);
  }
  return WideToUtf8(buffer.data(), buffer.size());
}
#endif
```

POSIX side (inside the `#else` block; note `#include <climits>` for `PATH_MAX` on macOS and keep `<unistd.h>` for `readlink`):

```cpp
#ifdef __APPLE__
std::string DeriveCanonicalPath(NativeHandle handle) {
  char buffer[PATH_MAX];
  if (fcntl(handle, F_GETPATH, buffer) == -1) {
    return {};
  }
  return std::string(buffer);
}
#else
std::string DeriveCanonicalPath(NativeHandle handle) {
  const std::string link = "/proc/self/fd/" + std::to_string(handle);
  std::string buffer(512, '\0');
  for (;;) {
    const ssize_t length = readlink(link.c_str(), buffer.data(), buffer.size());
    if (length < 0) {
      return {};
    }
    if (static_cast<size_t>(length) < buffer.size()) {
      buffer.resize(static_cast<size_t>(length));
      return buffer;
    }
    buffer.resize(buffer.size() * 2);
  }
}
#endif
```

(4) `SecureRoot` constructor derives identity and fails closed if derivation fails; add the instance method and register it in `Init`:

```cpp
  explicit SecureRoot(const Napi::CallbackInfo& info) : Napi::ObjectWrap<SecureRoot>(info) {
    if (info.Length() != 1 || !info[0].IsString()) {
      Napi::TypeError::New(info.Env(), "SecureRoot requires one absolute root path")
          .ThrowAsJavaScriptException();
      return;
    }
    const NativeHandle root = OpenAbsoluteDirectory(info[0].As<Napi::String>().Utf8Value());
    if (root == kInvalidHandle) {
      Napi::Error::New(info.Env(), "Failed to open secure filesystem root")
          .ThrowAsJavaScriptException();
      return;
    }
    canonical_path_ = DeriveCanonicalPath(root);
    if (canonical_path_.empty()) {
      CloseNativeHandle(root);
      Napi::Error::New(info.Env(),
                       "Failed to derive canonical identity from the opened root handle")
          .ThrowAsJavaScriptException();
      return;
    }
    state_ = std::make_shared<RootState>(root);
  }

  // In the private section:
  Napi::Value CanonicalPath(const Napi::CallbackInfo& info) {
    return Napi::String::New(info.Env(), canonical_path_);
  }
  std::string canonical_path_;
```

In `Init`, add to `DefineClass`: `InstanceMethod("canonicalPath", &SecureRoot::CanonicalPath),`.

- [ ] **Step 4: Build and run to verify GREEN**

```bash
pnpm --filter @brainstrike/secure-fs-native build && pnpm --filter @brainstrike/secure-fs-native test
```
Expected: all tests pass, including the existing `assert.equal(root.canonicalPath, realpathSync.native(workspace))` at line ~47 (handle-derived path equals realpath for a real directory) and the new symlinked-root test.

- [ ] **Step 5: Add the honesty doc-comment to `index.d.ts`**

Above `readonly canonicalPath: string;` in `packages/secure-fs-native/index.d.ts`:

```ts
  /**
   * Canonical identity derived from the opened root handle (F_GETPATH /
   * /proc/self/fd / GetFinalPathNameByHandle) — never from a pre-open
   * path lookup. Fixed at construction.
   */
  readonly canonicalPath: string;
```

- [ ] **Step 6: Grep for stale references and commit**

```bash
cd /private/tmp/brainstrike-bst-1237-v3
rg -n "realpathSync" packages/secure-fs-native/
```
Expected: hits only in `test/secure-root.test.cjs` (assertions), none in `index.cjs`.

```bash
pnpm dlx ultracite fix packages/secure-fs-native/index.cjs
git add packages/secure-fs-native
git commit -m "feat(secure-fs): derive root capability identity from the opened handle

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Native revocation + concurrency — drain semantics, no I/O lock

**Files:**
- Modify: `packages/secure-fs-native/src/secure_fs.cc` (`RootState` → snapshot/refcount; workers and sync methods stop holding a lock across I/O; Windows `ListDirectory` gets an independent cursor via relative reopen)
- Modify: `packages/secure-fs-native/README.md` (rewrite around identity / revocation / concurrency)
- Test: `packages/secure-fs-native/test/secure-root.test.cjs`

**Interfaces:**
- Consumes: Task 1's constructor/`canonical_path_`.
- Produces: `close()` that never blocks and fails-closed for *new* operations while in-flight operations drain. Task 3's registry relies on `unmount()`/root replacement being non-blocking on the main process.

- [ ] **Step 1: Write the failing tests**

Append to `packages/secure-fs-native/test/secure-root.test.cjs`:

```js
test('close never blocks on in-flight reads and fails new operations closed', async () => {
  const { commands, workspace } = fixture();
  for (let index = 0; index < 50; index += 1) {
    writeFileSync(path.join(commands, `bulk-${index}.md`), 'x'.repeat(4096));
  }
  const root = new SecureRoot(workspace);
  const inflight = [
    root.listDirAsync('.brainstrike/commands', 10_000),
    root.readFileAsync('.brainstrike/commands/bulk-0.md', 1024 * 1024),
    root.listDirAsync('.', 10_000),
  ];
  const before = process.hrtime.bigint();
  root.close();
  const closeMs = Number(process.hrtime.bigint() - before) / 1e6;
  // Drain semantics: close() only swaps the state pointer; it must not wait
  // for the queued/blocking I/O above (generous bound to avoid CI flake).
  assert.ok(closeMs < 250, `close() took ${closeMs}ms`);

  // New operations after close fail closed immediately.
  assert.equal(root.listDir('.', 10), null);
  assert.deepEqual(root.readFile('.brainstrike/commands/bulk-0.md', 1024), {
    status: 'unreadable',
  });
  const [lateList, lateRead] = [
    await root.listDirAsync('.', 10),
    await root.readFileAsync('.brainstrike/commands/bulk-0.md', 1024),
  ];
  assert.equal(lateList, null);
  assert.equal(lateRead.status, 'unreadable');

  // In-flight operations settle without rejection or crash; each either
  // completed against the pinned object or observed the revocation.
  const settled = await Promise.all(inflight);
  for (const result of settled) {
    assert.notEqual(result, undefined);
  }
});
```

- [ ] **Step 2: Run to verify RED**

```bash
pnpm --filter @brainstrike/secure-fs-native test
```
Expected: the new test FAILS or flakes on the timing assertion only if the workers were already queued before `close()` acquired the mutex — on the baseline, `Close()` blocks behind whichever worker holds `state_->mutex`, and queued workers still run against a since-closed fd returning `unreadable` for reasons the test distinguishes. If the timing bound alone doesn't reliably go RED locally, the post-close sync assertions still pass on baseline — the *structural* RED evidence is Step 3's removal of `std::lock_guard` from `Execute()`; keep the test regardless, it pins the new contract.

- [ ] **Step 3: Implement snapshot/refcount revocation**

Replace `RootState` (lines ~659-672) with:

```cpp
struct RootHandle {
  explicit RootHandle(NativeHandle opened) : handle(opened) {}
  RootHandle(const RootHandle&) = delete;
  RootHandle& operator=(const RootHandle&) = delete;
  ~RootHandle() { CloseNativeHandle(handle); }
  const NativeHandle handle;
};

struct RootState {
  explicit RootState(NativeHandle opened_root)
      : handle_(std::make_shared<const RootHandle>(opened_root)) {}

  // Snapshot the pinned handle. Null after Close(). The descriptor stays open
  // until the last snapshot is released, so in-flight operations drain against
  // the pinned object instead of racing a close.
  std::shared_ptr<const RootHandle> Acquire() {
    std::lock_guard<std::mutex> lock(mutex_);
    return handle_;
  }

  void Close() {
    std::lock_guard<std::mutex> lock(mutex_);
    handle_.reset();
  }

 private:
  std::shared_ptr<const RootHandle> handle_;
  std::mutex mutex_;  // guards the pointer slot only; never held across I/O
};
```

Rewrite `ListDirWorker::Execute` and `ReadFileWorker::Execute` (no lock across I/O):

```cpp
  void Execute() override {
    const auto root = state_->Acquire();
    if (root) {
      succeeded_ = ListDirectory(root->handle, components_, max_entries_, &entries_,
                                 &inspected_, &truncated_);
    }
  }
```

```cpp
  void Execute() override {
    const auto root = state_->Acquire();
    if (root) {
      status_ = ReadRelativeFile(root->handle, components_, max_bytes_, &content_);
    }
  }
```

Rewrite the sync `ListDir` / `ReadFile` bodies the same way — replace `std::lock_guard<std::mutex> lock(state_->mutex);` + `state_->root != kInvalidHandle` checks with `const auto root = state_->Acquire();` and `root` truthiness; pass `root->handle`.

- [ ] **Step 4: Give Windows enumeration an independent cursor**

In the `#ifdef _WIN32` block, add next to `OpenRelativeDirectory`:

```cpp
// Reopens the directory that `root` refers to via a handle-relative open with
// an empty name, yielding an independent open (and enumeration cursor) on the
// same directory object. Never resolves through a path.
NativeHandle ReopenDirectory(NativeHandle root) {
  const auto nt_create_file = ResolveNtCreateFile();
  if (nt_create_file == nullptr) {
    return kInvalidHandle;
  }
  UNICODE_STRING empty_name{};
  static wchar_t kEmpty[] = L"";
  empty_name.Buffer = kEmpty;
  empty_name.Length = 0;
  empty_name.MaximumLength = 0;
  OBJECT_ATTRIBUTES attributes{};
  InitializeObjectAttributes(&attributes, &empty_name,
                             OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE, root, nullptr);
  IO_STATUS_BLOCK status_block{};
  HANDLE result = kInvalidHandle;
  const NTSTATUS status = nt_create_file(
      &result,
      FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      &attributes, &status_block, nullptr, FILE_ATTRIBUTE_NORMAL,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, FILE_OPEN,
      FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT | FILE_DIRECTORY_FILE,
      nullptr, 0);
  if (status < 0 || result == kInvalidHandle) {
    return kInvalidHandle;
  }
  return result;
}
```

Then in the Windows `ListDirectory`, remove the `borrowed_root` concept entirely:

```cpp
bool ListDirectory(NativeHandle root, const std::vector<std::string>& components,
                   size_t max_entries, std::vector<DirEntry>* entries, size_t* inspected,
                   bool* truncated) {
  NativeHandle directory =
      components.empty() ? ReopenDirectory(root) : OpenRelativeDirectory(root, components);
  if (directory == kInvalidHandle) {
    return false;
  }
  ...  // unchanged enumeration loop, EXCEPT: every early return now does
       // CloseNativeHandle(directory) unconditionally (no borrowed_root guard),
       // and `restart` can start as `true` exactly as before (fresh handle).
}
```

(`ReadRelativeFile` on Windows may keep using `root` directly as the `RootDirectory` of the leaf open when `parent_components` is empty — object-attribute-relative opens do not touch an enumeration cursor and are safe concurrently. Leave that code as-is, but delete its `borrowed_root` *close-guard* only if you changed ownership; on inspection it does not close the borrowed root today, so no change is needed there.)

POSIX `ListDirectory` needs no change: `OpenRelativeDirectory` already opens a fresh `.` fd even for empty components.

- [ ] **Step 5: Build + run to verify GREEN**

```bash
pnpm --filter @brainstrike/secure-fs-native build && pnpm --filter @brainstrike/secure-fs-native test
```
Expected: all tests pass, including `repeated and concurrent root listings each enumerate the complete directory` (L110) which now exercises truly concurrent enumeration.

- [ ] **Step 6: Rewrite the README**

Replace `packages/secure-fs-native/README.md` body with:

```markdown
# `@brainstrike/secure-fs-native`

A read-only filesystem *capability* for Electron main-process code. A
`SecureRoot` pins one directory handle; the contract has three dimensions:

**Identity.** The constructor is the only resolver. It opens the requested
root directly — following symlinks for root establishment only, because root
paths come from the trusted folder picker or persisted store, never from
repository content — and derives `canonicalPath` from the opened handle
(`fcntl(F_GETPATH)` on macOS, `readlink /proc/self/fd` on Linux,
`GetFinalPathNameByHandle` on Windows). No pre-open path lookup vouches for
the capability; the pinned object is the authority for its own identity.

**Traversal.** Every descendant directory and file is opened
component-by-component relative to the pinned handle: POSIX
[`openat`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/open.html)
with `O_NOFOLLOW`, Windows
[`NtCreateFile`](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile)
with `OBJECT_ATTRIBUTES.RootDirectory`, `OBJ_DONT_REPARSE`, and
`FILE_OPEN_REPARSE_POINT`. Symbolic links/reparse points, `..`, separators
inside components, and NUL bytes fail closed. Built on stable
[Node-API](https://nodejs.org/api/n-api.html) via the
[Electron native-module workflow](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules/).

**Revocation.** `close()` never blocks: it revokes the capability for *new*
operations (which fail closed with `null` / `unreadable`) while in-flight
operations drain against the pinned object; the descriptor is released when
the last one finishes.

**Concurrency.** Operations do not serialize. Each enumeration owns an
independent directory cursor (POSIX opens a fresh `.` descriptor relative to
the root; Windows reopens the root handle-relatively), so concurrent calls
cannot share or corrupt a cursor, and no lock is held across blocking I/O.

`listDir(relativePath, maxEntries)` bounds enumeration natively and returns
`{ entries, inspected, truncated }` — `truncated` is a partial-result signal,
not an error; callers must debit `inspected` from their traversal budget and
surface truncation visibly. `readFile(relativePath, maxBytes)` applies its
byte limit before returning content and distinguishes `not-found`,
`oversized`, and fail-closed `unreadable`. The async methods preserve the
same contracts on native workers.

There is deliberately no path-based fallback. If the native binding or secure
traversal is unavailable, callers receive an error/null result and must fail
closed.
```

- [ ] **Step 7: Commit**

```bash
git add packages/secure-fs-native
git commit -m "feat(secure-fs): drain-based revocation and independent enumeration cursors

close() revokes new operations without blocking main; in-flight reads
drain against the pinned object. Windows listings reopen the root
handle-relatively so no lock is held across blocking I/O.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Registry mount-then-ask + session-root dedup

**Files:**
- Modify: `apps/desktop/src/ipc-domains/workspace-root-registry.ts` (`mount`, new `installMount`, `addRoot`, `restoreRoots`)
- Test: `apps/desktop/src/__tests__/ipc-domains/workspace-root-registry.test.ts` (the suite exists from the baseline; add cases)

**Interfaces:**
- Consumes: Task 1's `createSecureRoot(entry.path)` accepting presentation paths; the injectable `options.createSecureRoot` seam for tests.
- Produces: `private installMount(entry: StoredWorkspaceRoot, secureRoot: SecureWorkspaceRoot): string` (returns normalized canonical path); `private async mount(entry: StoredWorkspaceRoot): Promise<string>`; `addRoot` that never double-mounts one canonical path. Task 4/5 edit the same file on top of these shapes.

- [ ] **Step 1: Write the failing tests**

Add to the existing registry test file (reuse its storage/db fakes; the cases below are self-contained given a `makeRegistry`-style helper — if none exists, construct `new WorkspaceRootRegistry({...})` with inline fakes as the existing tests do):

```ts
test('re-adding a folder whose persist failed reuses the session capability', async () => {
  const closes: number[] = [];
  let minted = 0;
  let failPersist = true;
  const storage = createMemoryStorage(); // existing fake in this suite
  storage.setItem = async (key: string, value: string) => {
    if (key === 'rootsList' && failPersist) {
      throw new Error('disk full');
    }
    storage.backing.set(key, value);
  };
  const registry = new WorkspaceRootRegistry({
    createSecureRoot: async () => {
      minted += 1;
      const id = minted;
      return {
        canonicalPath: '/canon/project',
        close: () => {
          closes.push(id);
        },
        listDir: async () => ({ entries: [], inspected: 0, truncated: false }),
        readFile: async () => ({ status: 'unreadable' as const }),
      };
    },
    getRootsDatabase: async () => fakeRootsDb(),
    pathExists: async () => true,
    storage,
  });
  const handle = {
    kind: 'directory',
    name: 'project',
    path: '/canon/project',
    platform: 'electron',
  } as DirectoryHandle;

  const first = await registry.addRoot(handle);
  expect(first.persisted).toBe(false);

  failPersist = false;
  const second = await registry.addRoot(handle);
  expect(second.persisted).toBe(true);
  // Same canonical path ⇒ same durable root, not a second capability:
  expect(second.rootId).toBe(first.rootId);
  // Exactly one live mount; every superseded/probe capability was closed.
  expect(minted - closes.length).toBe(1);
});

test('restoreRoots adopts a persisted entry over a session mount of the same path', async () => {
  // Arrange: session root mounted (persist failed), then rootsList written
  // out-of-band with an entry whose path canonicalizes to the same root.
  // Assert: after restoreRoots() there is one mount, owned by the persisted
  // rootId, and the session capability was closed.
});
```

Fill the second test using the same fakes: seed `storage.backing.set('rootsList', JSON.stringify([{ addedAt: 1, path: '/canon/project', rootId: 'persisted-id' }]))` after the failed-persist `addRoot`, call `await registry.restoreRoots()`, then assert the descriptors contain only `persisted-id`, and `minted - closes.length === 1`.

- [ ] **Step 2: Run to verify RED**

```bash
pnpm --filter @brainstrike/desktop vitest run src/__tests__/ipc-domains/workspace-root-registry.test.ts
```
Expected: FAIL — baseline `addRoot` dedupes against stored entries only, so the second add mints a new `rootId` and leaks the first mount.

- [ ] **Step 3: Implement mount-then-ask**

In `workspace-root-registry.ts`, replace `mount` (lines ~552-593) with:

```ts
  private installMount(entry: StoredWorkspaceRoot, secureRoot: SecureWorkspaceRoot): string {
    const canonicalPath = path.normalize(secureRoot.canonicalPath);
    const current = this.mounted.get(entry.rootId);
    this.mounted.set(entry.rootId, {
      canonicalPath,
      presentationPath: path.normalize(entry.path),
      root: secureRoot,
      rootId: entry.rootId,
    });
    if (current && current.root !== secureRoot) {
      this.closeMountedRoot(current);
    }
    return canonicalPath;
  }

  private async mount(entry: StoredWorkspaceRoot): Promise<string> {
    this.assertActive();
    // Mount-then-ask: the capability's handle-derived canonicalPath is the
    // identity authority; no pre-open path lookup vouches for it.
    const secureRoot = await this.createSecureRoot(entry.path);
    if (this.disposed) {
      try {
        secureRoot.close();
      } catch (error) {
        logger.warn('Failed to close a workspace root capability during disposal', { error });
      }
      this.assertActive();
    }
    return this.installMount(entry, secureRoot);
  }
```

(The old post-open `pathsEqual(secureRoot.canonicalPath, canonicalPath)` swap check is deleted — there is no pre-claim left to compare against.)

- [ ] **Step 4: Rewrite `addRoot` with probe + cross-mounted dedup**

Replace `addRoot` (lines ~263-323) with:

```ts
  addRoot(handle: DirectoryHandle): Promise<RootDescriptor> {
    return this.serializeMutation(async () => {
      const presentationPath = path.normalize(handle.path);
      const [entries, probe] = await Promise.all([
        this.readStoredRoots(),
        this.createSecureRoot(presentationPath),
      ]);
      let probeAdopted = false;
      try {
        const canonicalPath = path.normalize(probe.canonicalPath);
        const mountedMatch = [...this.mounted.values()].find((candidate) =>
          pathsEqual(candidate.canonicalPath, canonicalPath)
        );
        let existing: StoredWorkspaceRoot | undefined;
        for (const candidate of entries) {
          if (mountedMatch && candidate.rootId === mountedMatch.rootId) {
            existing = candidate;
            break;
          }
          if (!this.mounted.has(candidate.rootId)) {
            try {
              if (pathsEqual(await this.resolveCanonicalRoot(candidate.path), canonicalPath)) {
                existing = candidate;
                break;
              }
            } catch (error) {
              logger.warn('Could not canonicalize a stored root while adding a folder', {
                error,
                rootId: candidate.rootId,
              });
            }
          }
        }

        const rootId = existing?.rootId ?? mountedMatch?.rootId ?? crypto.randomUUID();
        const entry: StoredWorkspaceRoot = {
          addedAt: Date.now(),
          path: existing?.path ?? presentationPath,
          rootId,
        };

        if (mountedMatch && mountedMatch.rootId !== rootId) {
          // A session mint of the same canonical path is superseded by the
          // durable identity; exactly one capability may serve a root.
          this.mounted.delete(mountedMatch.rootId);
          this.sessionRootIds.delete(mountedMatch.rootId);
          this.closeMountedRoot(mountedMatch);
        }
        if (mountedMatch && mountedMatch.rootId === rootId
            && pathsEqual(mountedMatch.presentationPath, entry.path)) {
          // Identical mount already pinned — the probe is redundant.
        } else {
          this.installMount(entry, probe);
          probeAdopted = true;
        }

        let persisted = true;
        const nextEntries = existing
          ? entries.map((candidate) => (candidate.rootId === existing.rootId ? entry : candidate))
          : [...entries, entry];
        try {
          await this.writeStoredRoots(nextEntries);
          this.sessionRootIds.delete(entry.rootId);
        } catch (error) {
          if (existing) {
            logger.warn('Failed to refresh an already-persisted workspace root', {
              error,
              rootId: entry.rootId,
            });
          } else {
            persisted = false;
            this.sessionRootIds.add(entry.rootId);
            logger.warn('Workspace root is mounted for this session but could not be persisted', {
              error,
              rootId: entry.rootId,
            });
          }
        }

        if (persisted) {
          await this.storage
            .setItem(LAST_FOLDER_STORAGE_KEY, entry.path)
            .catch((error: unknown) => {
              logger.warn('Failed to update the last-folder presentation preference', { error });
            });
        }
        return descriptorFor(entry, 'granted', persisted);
      } finally {
        if (!probeAdopted) {
          try {
            probe.close();
          } catch (error) {
            logger.warn('Failed to close a redundant workspace root probe', { error });
          }
        }
      }
    });
  }
```

(Note: `readStoredRoots` here becomes `readStoredRootsOrQuarantine` in Task 4 — keep the plain call for now so this task stays reviewable on its own.)

- [ ] **Step 5: Update `restoreRoots` to mount-then-ask + session adoption**

Replace the loop body of `restoreRoots` (lines ~454-507). The full method:

```ts
  restoreRoots(): Promise<RootDescriptor[]> {
    return this.serializeMutation(async () => {
      const entries = await this.readStoredRoots();
      const descriptors: RootDescriptor[] = [];
      const retainedRootIds = new Set(this.sessionRootIds);
      const retainedCanonicalPaths = new Set<string>();
      const storedSurvivors: StoredWorkspaceRoot[] = [];

      for (const entry of entries) {
        let canonicalPath: string;
        try {
          if (!(await this.pathExists(entry.path))) {
            logger.warn('Workspace root is unavailable and will remain persisted for retry', {
              rootId: entry.rootId,
            });
            descriptors.push(descriptorFor(entry, 'unknown'));
            storedSurvivors.push(entry);
            continue;
          }
          canonicalPath = await this.mount(entry);
        } catch (error) {
          logger.error('Workspace root mount failed and remains persisted for retry', {
            error,
            rootId: entry.rootId,
          });
          descriptors.push(descriptorFor(entry, 'unknown'));
          storedSurvivors.push(entry);
          continue;
        }
        if (retainedCanonicalPaths.has(pathKey(canonicalPath))) {
          logger.warn('Discarding a duplicate persisted alias for the same workspace root', {
            rootId: entry.rootId,
          });
          this.unmount(entry.rootId);
          continue;
        }
        // A session mint of the same canonical path is superseded by the
        // persisted identity.
        for (const candidate of [...this.mounted.values()]) {
          if (
            candidate.rootId !== entry.rootId &&
            this.sessionRootIds.has(candidate.rootId) &&
            pathsEqual(candidate.canonicalPath, canonicalPath)
          ) {
            this.sessionRootIds.delete(candidate.rootId);
            retainedRootIds.delete(candidate.rootId);
            this.unmount(candidate.rootId);
          }
        }
        retainedCanonicalPaths.add(pathKey(canonicalPath));
        retainedRootIds.add(entry.rootId);
        storedSurvivors.push(entry);
        descriptors.push(descriptorFor(entry, 'granted'));
      }

      for (const rootId of [...this.mounted.keys()]) {
        if (!retainedRootIds.has(rootId)) {
          this.unmount(rootId);
        }
      }
      if (storedSurvivors.length !== entries.length) {
        await this.writeStoredRoots(storedSurvivors);
      }
      await this.convergeDatabase();
      return descriptors;
    });
  }
```

- [ ] **Step 6: Run to verify GREEN, then run the whole registry + IPC suites**

```bash
pnpm --filter @brainstrike/desktop vitest run src/__tests__/ipc-domains/workspace-root-registry.test.ts src/__tests__/ipc-domains/file-system-ipc.test.ts
```
Expected: PASS. If baseline tests asserted the old pre-claim swap-check error message (`'Workspace root changed while its filesystem capability was being mounted.'`), delete those assertions — that error no longer exists by design; note the deletion in the commit body.

- [ ] **Step 7: Commit**

```bash
pnpm dlx ultracite fix apps/desktop/src/ipc-domains/workspace-root-registry.ts
git add apps/desktop/src
git commit -m "feat(desktop): mount-then-ask root identity and cross-mount dedup

The capability's handle-derived canonicalPath is the identity authority;
the vacuous pre-claim swap check is deleted, and one canonical path can
never be served by two capabilities (session mints are superseded).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Corrupt `rootsList` quarantine on add/remove

**Files:**
- Modify: `apps/desktop/src/ipc-domains/workspace-root-registry.ts` (new constant, new `readStoredRootsOrQuarantine`, swap call in `addRoot` + `removeRoot`)
- Test: `apps/desktop/src/__tests__/ipc-domains/workspace-root-registry.test.ts`

**Interfaces:**
- Consumes: Task 3's `addRoot`/`removeRoot` shapes.
- Produces: storage key `'rootsList.corrupt'`; `restoreRoots` still throws on corruption (unchanged fail-loud invariant that existing tests pin).

- [ ] **Step 1: Write the failing tests**

```ts
test('addRoot quarantines a corrupt rootsList and proceeds with a fresh list', async () => {
  const storage = createMemoryStorage();
  storage.backing.set('rootsList', '{not json');
  const registry = makeRegistry({ storage }); // same fakes as Task 3
  const descriptor = await registry.addRoot(projectHandle);
  expect(descriptor.persisted).toBe(true);
  expect(storage.backing.get('rootsList.corrupt')).toBe('{not json');
  const list = JSON.parse(storage.backing.get('rootsList') ?? '[]') as unknown[];
  expect(list).toHaveLength(1);
});

test('restoreRoots still fails loud on a corrupt rootsList', async () => {
  const storage = createMemoryStorage();
  storage.backing.set('rootsList', '{not json');
  const registry = makeRegistry({ storage });
  await expect(registry.restoreRoots()).rejects.toThrow(
    'The persisted workspace root registry is not valid JSON.'
  );
  // Convergence must not run: unknown mount set is never an authoritative zero.
});
```

(The second test may already exist from the baseline — if so, keep it and only add the first.)

- [ ] **Step 2: Run to verify RED**

```bash
pnpm --filter @brainstrike/desktop vitest run src/__tests__/ipc-domains/workspace-root-registry.test.ts
```
Expected: first test FAILS — `addRoot` rejects with the JSON error.

- [ ] **Step 3: Implement quarantine**

In `workspace-root-registry.ts`, next to `ROOTS_LIST_STORAGE_KEY`:

```ts
const CORRUPT_ROOTS_LIST_STORAGE_KEY = 'rootsList.corrupt' as const;
```

Add below `readStoredRoots`:

```ts
  /**
   * Mutation-path reader: a corrupt store must not brick add/remove, but it is
   * never coerced — the raw value is preserved for diagnosis and the failure
   * is logged at error level. Convergence paths (restoreRoots) intentionally
   * keep the throwing readStoredRoots: an unknown mount set is never an
   * authoritative zero.
   */
  private async readStoredRootsOrQuarantine(): Promise<StoredWorkspaceRoot[]> {
    try {
      return await this.readStoredRoots();
    } catch (error) {
      const raw = await this.storage.getItem(ROOTS_LIST_STORAGE_KEY);
      if (raw !== null) {
        await this.storage.setItem(CORRUPT_ROOTS_LIST_STORAGE_KEY, raw);
        await this.storage.removeItem(ROOTS_LIST_STORAGE_KEY);
      }
      logger.error('Quarantined a corrupt workspace root registry value', { error });
      return [];
    }
  }
```

Swap the first line of `addRoot`'s `Promise.all` and of `removeRoot` from `this.readStoredRoots()` to `this.readStoredRootsOrQuarantine()`. (Quarantine I/O failures propagate — fail loud.)

- [ ] **Step 4: Run to verify GREEN and commit**

```bash
pnpm --filter @brainstrike/desktop vitest run src/__tests__/ipc-domains/workspace-root-registry.test.ts
git add apps/desktop/src
git commit -m "fix(desktop): quarantine corrupt rootsList on mutation paths

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Truncation as a visible partial result

**Files:**
- Modify: `packages/types/src/file-system.ts:4` (`FileNodeType` union += `'truncated'`)
- Modify: `apps/desktop/src/ipc-domains/workspace-root-registry.ts` (`readDirectory` stops throwing; new `buildTruncationNode`)
- Modify: `packages/file-explorer-ui/src/tree/optimized-file-tree-model.ts` (`sortRowsPerDirectory` keeps the marker last; both row builders tolerate the type)
- Modify: `packages/file-explorer-ui/src/tree/file-tree-name-cell.tsx` (icon + muted style for `'truncated'`)
- Modify: `packages/file-explorer-ui/src/context-actions/file-entry-target.ts` (null target)
- Modify: `packages/file-explorer-ui/src/utils/worker-node-conversion.ts` (filter `'truncated'` like `'loadMore'`)
- Modify: `docs/agents/explorer-search-tapestry.md` (contract wording), spec file (parent-flag → pseudo-node amendment)
- Test: `apps/desktop/src/__tests__/ipc-domains/workspace-root-registry.test.ts`, plus the tree-model test file next to `optimized-file-tree-model.ts`

**Interfaces:**
- Consumes: `SecureListResult.inspected/truncated` (native, unchanged); Task 3's registry `readDirectory`.
- Produces: `FileNodeType = 'file' | 'directory' | 'loadMore' | 'truncated'`; registry emits a trailing `IFileNode` of type `'truncated'` named `` `Showing first ${inspected} entries` `` with path `` path.join(parentPath, '…truncated…') ``. No IPC/adapter signature changes anywhere.

- [ ] **Step 1: Write the failing registry test**

```ts
test('a truncated listing returns the partial entries plus a visible marker node', async () => {
  const registry = makeRegistry({
    createSecureRoot: async () => ({
      canonicalPath: '/canon/project',
      close: () => undefined,
      listDir: async () => ({
        entries: [
          { isDirectory: false, isFile: true, isSymbolicLink: false, name: 'a.md', size: 1 },
          { isDirectory: true, isFile: false, isSymbolicLink: false, name: 'sub' },
        ],
        inspected: 10_000,
        truncated: true,
      }),
      readFile: async () => ({ status: 'unreadable' as const }),
    }),
  });
  const descriptor = await registry.addRoot(projectHandle);
  const nodes = await registry.readDirectory(descriptor.handle as DirectoryHandle);
  expect(nodes).toHaveLength(3);
  const marker = nodes.at(-1);
  expect(marker?.type).toBe('truncated');
  expect(marker?.name).toBe('Showing first 10,000 entries');
  expect(marker?.selectionState).toBe('unchecked');
});
```

Also DELETE (or invert) the baseline test that asserts the `Directory exceeds the 10,000-entry safety limit.` throw — the hard failure is removed by design.

- [ ] **Step 2: Run to verify RED**

```bash
pnpm --filter @brainstrike/desktop vitest run src/__tests__/ipc-domains/workspace-root-registry.test.ts
```
Expected: FAIL — baseline throws `AccessError` on `truncated`.

- [ ] **Step 3: Type union + registry implementation**

`packages/types/src/file-system.ts:4`:

```ts
export type FileNodeType = 'file' | 'directory' | 'loadMore' | 'truncated';
```

In `workspace-root-registry.ts`, add near `buildDirectoryNode`:

```ts
const TRUNCATION_NODE_BASENAME = '…truncated…' as const;

function buildTruncationNode(
  mounted: MountedWorkspaceRoot,
  parentPath: string,
  inspected: number
): IFileNode {
  const entryPath = path.join(parentPath, TRUNCATION_NODE_BASENAME);
  return {
    depth: 0,
    handle: {
      kind: 'file',
      name: TRUNCATION_NODE_BASENAME,
      path: entryPath,
      platform: 'electron',
      rootId: mounted.rootId,
    } as unknown as FileSystemFileHandle,
    isVisible: true,
    name: `Showing first ${inspected.toLocaleString('en-US')} entries`,
    path: entryPath,
    rootFolderId: mounted.rootId,
    selectionState: 'unchecked',
    type: 'truncated',
  };
}
```

Replace the `if (listing.truncated) { throw ... }` block in `readDirectory` with nothing, and change the return to:

```ts
    const nodes = listing.entries
      .map((entry) => buildDirectoryNode(resolved.mounted, handle.path, entry))
      .sort((left, right) => {
        if (left.type !== right.type) {
          return left.type === 'directory' ? -1 : 1;
        }
        return fileNodeCollator.compare(left.name, right.name);
      });
    if (listing.truncated) {
      // Partial result, surfaced: the native bound held, the caller sees it.
      nodes.push(buildTruncationNode(resolved.mounted, handle.path, listing.inspected));
    }
    return nodes;
```

- [ ] **Step 4: Renderer pseudo-node handling — enumerate every `'loadMore'` site and mirror it**

```bash
rg -n "'loadMore'" packages apps --type ts --type tsx
```

Expected sites (mirror `'truncated'` at each; if the sweep finds more, mirror there too and note it in the commit):

1. `packages/file-explorer-ui/src/tree/file-tree-name-cell.tsx:42` — render an `Info` icon (lucide) with muted italic text for `'truncated'`:

```tsx
  if (nodeType === 'truncated') {
    return <Info className="text-gray-400 dark:text-gray-500" size={16} />;
  }
  if (nodeType === 'file' || nodeType === 'loadMore') {
    return <FileIcon className="text-gray-500 dark:text-gray-400" size={16} />;
  }
```

(also apply the muted/italic label styling where the cell renders the name — follow the cell's existing conditional-className pattern.)

2. `packages/file-explorer-ui/src/context-actions/file-entry-target.ts:10`:

```ts
  if (node.type === 'loadMore' || node.type === 'truncated') {
    return null;
  }
```

3. `packages/file-explorer-ui/src/utils/worker-node-conversion.ts:18-22` — extend the filter that drops `'loadMore'` to also drop `'truncated'` (same expression shape as the existing check).

4. `packages/file-explorer-ui/src/tree/optimized-file-tree-model.ts` — in `sortRowsPerDirectory`'s comparator (find it below `buildFileTreeRows`), pin the marker last within its directory:

```ts
    if (left.type === 'truncated' || right.type === 'truncated') {
      if (left.type === right.type) {
        return 0;
      }
      return left.type === 'truncated' ? 1 : -1;
    }
```

Check the second (worker-flattened) row builder at ~L1149-1200 renders the node like any leaf (it should, `type` passes through) — no `hasChildren` since `hasChildren: node.type === 'directory'` already excludes it.

5. Selection machinery: run `rg -n "type === 'directory'|type === 'file'" packages/file-explorer-ui/src packages/file-explorer-hooks/src` and inspect tri-state rollup code paths; anywhere `'loadMore'` is excluded from selection aggregation, exclude `'truncated'` identically. If rollups are driven purely by `selectionState` and the two known filters above, no change is needed — state that in the commit body either way.

- [ ] **Step 5: Write the failing tree-model test, then verify**

In the test file adjacent to `optimized-file-tree-model.ts` (find with `ls packages/file-explorer-ui/src/tree/__tests__/`), add:

```ts
test('a truncated marker row sorts last within its directory and is not expandable', () => {
  const rows = buildFileTreeRows(
    [
      fileNode({ name: 'zzz.md', path: '/r/zzz.md' }),
      truncatedNode({ path: '/r/…truncated…', name: 'Showing first 10,000 entries' }),
      directoryNode({ name: 'aaa', path: '/r/aaa' }),
    ],
    defaultOptions()
  );
  expect(rows.at(-1)?.type).toBe('truncated');
  expect(rows.at(-1)?.hasChildren).toBe(false);
});
```

(Build `fileNode`/`directoryNode`/`truncatedNode`/`defaultOptions` from the file's existing test helpers — the suite already constructs `IFileNode` fixtures for `buildFileTreeRows`.)

```bash
pnpm --filter @brainstrike/file-explorer-ui test
pnpm --filter @brainstrike/desktop vitest run src/__tests__/ipc-domains/workspace-root-registry.test.ts
```
Expected: PASS after Steps 3-4.

- [ ] **Step 6: Update the contract docs + spec amendment**

`docs/agents/explorer-search-tapestry.md` (~L287): replace the sentence

> Listings fail visibly above 10,000 inspected entries, and file bytes are bounded before crossing into JavaScript.

with:

> Listings are bounded at 10,000 inspected entries: the partial result renders
> with an explicit trailing `'truncated'` pseudo-node ("Showing first N
> entries") — never a hard failure and never a silent partial. File bytes are
> bounded before crossing into JavaScript.

Spec file `docs/superpowers/specs/2026-08-12-bst-1237-canonical-capability-design.md` §3: replace the `truncatedChildren: true` parent-flag bullet with the pseudo-node approach ("registry appends a trailing `'truncated'` node; no IPC/adapter signature changes; mirrors the existing `'loadMore'` pseudo-node handling").

- [ ] **Step 7: Type-check the workspace and commit**

```bash
pnpm --filter @brainstrike/types --filter @brainstrike/file-explorer-ui --filter @brainstrike/desktop type-check
git add packages/types packages/file-explorer-ui apps/desktop/src docs
git commit -m "feat(explorer): render directory truncation as a visible partial result

Truncated listings return their first 10,000 entries with a trailing
'truncated' pseudo-node instead of failing the whole directory.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Deletions + guards (findings 5, 6; read-cap guard; React Doctor)

**Files:**
- Modify: `apps/desktop/src/ipc-domains/file-system-ipc.ts` (delete `workspaceRootRegistry` option; lines ~40, ~295, ~299-300)
- Modify: `apps/desktop/src/renderer/adapters.ts:167-176` (delete the `saveLastFolder` write)
- Modify: `apps/desktop/src/ipc-domains/workspace-root-registry.ts` (`readFile` cap guard; `filter().map()` → single-pass at ~L407 and ~L540)
- Test: `apps/desktop/src/__tests__/ipc-domains/workspace-root-registry.test.ts`

**Interfaces:**
- Consumes: Tasks 3-5 registry shapes.
- Produces: `RegisterFileSystemIpcHandlersOptions` without `workspaceRootRegistry`; renderer `requestDirectoryAccess()` that performs no follow-up IPC.

- [ ] **Step 1: Failing test for the read-cap guard**

```ts
test('a configured maxFileSize above the native cap fails loud, not unreadable', async () => {
  const registry = makeRegistry({});
  const descriptor = await registry.addRoot(projectHandle);
  setFileSizeConfig({ maxFileSize: 17 * 1024 * 1024 }); // import from @brainstrike/file-system
  try {
    await expect(
      registry.readFile({ kind: 'file', name: 'a.md', path: '/canon/project/a.md', platform: 'electron', rootId: descriptor.rootId })
    ).rejects.toThrow(/exceeds the native secure-read cap/);
  } finally {
    setFileSizeConfig({ maxFileSize: 750 * 1024 }); // restore default; check the real default via getFileSizeConfig() before hardcoding
  }
});
```

Run: `pnpm --filter @brainstrike/desktop vitest run src/__tests__/ipc-domains/workspace-root-registry.test.ts` → RED (native fake returns `unreadable`, so the read rejects with `File is not accessible.` instead).

- [ ] **Step 2: Implement guard + single-pass loops**

In `readFile`, after `const { maxFileSize } = getFileSizeConfig();`:

```ts
const NATIVE_MAX_READ_BYTES = 16 * 1024 * 1024;  // module-scope constant, top of file
```

```ts
    if (maxFileSize > NATIVE_MAX_READ_BYTES) {
      throw new AccessError(
        `Configured maxFileSize (${formatFileSize(maxFileSize)}) exceeds the native secure-read cap (${formatFileSize(NATIVE_MAX_READ_BYTES)}).`,
        requestedPath,
        'read'
      );
    }
```

Convert the two `.filter().map()` chains (in `removeRoot`'s `mountedPaths` and `convergeDatabase`) to single `for...of` loops building `string[]` — same predicate (`rootId` mismatch / not in `sessionRootIds`), same output.

- [ ] **Step 3: Delete the dead seam and the renderer write**

`file-system-ipc.ts`: remove `workspaceRootRegistry` from `RegisterFileSystemIpcHandlersOptions` (~L40), from the destructure (~L295), and change `const roots = workspaceRootRegistry ?? new WorkspaceRootRegistry({...})` to `const roots = new WorkspaceRootRegistry({...})`.

`apps/desktop/src/renderer/adapters.ts`:

```ts
  async requestDirectoryAccess(): Promise<DirectoryHandle> {
    // Main owns the last-folder preference: fs:requestDirectoryAccess routes
    // through the registry's addRoot, which persists it on success.
    return requireElectronAPI().fileSystem.requestDirectoryAccess();
  }
```

- [ ] **Step 4: Verify + commit**

```bash
rg -n "workspaceRootRegistry" apps/desktop/src        # expected: no hits outside the registry class file itself
pnpm --filter @brainstrike/desktop vitest run src/__tests__/ipc-domains/ && pnpm --filter @brainstrike/desktop type-check
git add apps/desktop/src
git commit -m "fix(desktop): drop dead registry seam, renderer last-folder write; fail loud on read-cap overflow

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Sweep dependent suites and hooks

**Files:**
- Test-only sweep: `apps/desktop/src/__tests__/**` (IPC + main handlers), `packages/file-explorer-hooks` (53-test suite), `packages/file-system` tests
- Modify: only where assertions pin behavior this redesign intentionally changed (old swap-check message, truncation throw, renderer saveLastFolder call counts)

**Interfaces:**
- Consumes: everything above.
- Produces: green package suites; a written list (in the commit body) of every assertion changed and which design decision changed it.

- [ ] **Step 1: Run the affected package suites**

```bash
pnpm --filter @brainstrike/desktop test
pnpm --filter @brainstrike/file-explorer-hooks test
pnpm --filter @brainstrike/file-system test
pnpm --filter @brainstrike/file-explorer-ui test
```

- [ ] **Step 2: Fix only intentional-change fallout**

Legitimate fixes: assertions on the deleted swap-check error, the deleted truncation throw, `saveLastFolder` IPC call expectations in renderer adapter tests, and `use-file-system.ts` tests that mock `requestDirectoryAccess` + `saveLastFolder` together. Anything else that fails is a regression in Tasks 1-6 — fix the implementation, not the test (systematic-debugging applies; do not weaken unrelated assertions).

- [ ] **Step 3: Integration lanes for the touched packages**

```bash
pnpm --filter @brainstrike/desktop test:integration
```
Expected: the `workspace-root-registry.integration.test.ts` real-PGlite/real-FS lane passes (it exercises real symlinks against the rebuilt native addon).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: align suites with the canonical capability contract

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Docs pass

**Files:**
- Modify: `docs/agents/explorer-search-tapestry.md` (verify Task 5 edit is coherent in context; add the drain-revocation sentence if the doc describes unmount behavior)
- Modify: any other `docs/agents/*.md` the baseline touched that still describes the old contract — check with the grep below
- Verify: `packages/secure-fs-native/README.md` (rewritten in Task 2)

**Interfaces:** none produced; documentation converges on the shipped behavior.

- [ ] **Step 1: Grep for stale contract language**

```bash
rg -n "realpath|borrowed handle|serialize per root|safety limit|canonicalPath" docs/agents packages/secure-fs-native/README.md
```
Fix every hit that describes pre-redesign behavior (pre-open realpath identity, per-root serialization, truncation-as-failure). Living-contract rule: the doc and its paired tests update in the same change.

- [ ] **Step 2: Commit**

```bash
git add docs
git commit -m "docs: align agent contracts with the canonical capability redesign

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Full gate

**Files:** none new — fix-forward only.

- [ ] **Step 1: The whole bar, one run**

```bash
cd /private/tmp/brainstrike-bst-1237-v3
pnpm lint && pnpm type-check && pnpm build && pnpm test
```
Expected: all green in the same run. Known environment traps: local timeouts are HALF of CI's (diff-isolate before blaming your change); a V8 JIT crash in a vitest worker (`ThreadIsolation::UnregisterWasmAllocation` native stack + one test file with no verdict) is a known Node 24 flake — rerun that lane serialized before investigating.

- [ ] **Step 2: React Doctor**

```bash
pnpm run react-doctor
```
Expected: no NEW error-severity issues; the three baseline warnings on `workspace-root-registry.ts` are resolved by Tasks 3/6.

- [ ] **Step 3: Commit any fix-forward fallout (one commit, explained)**

---

### Task 10: PR + supersession

- [ ] **Step 1: Push and open the PR**

```bash
git push -u origin claude/bst-1237-canonical-capability
gh pr create --title "fix(desktop): canonical native capability contract for workspace roots" --body "$(cat <<'EOF'
## Summary

Clean replacement for #2418 (which replaced #2410). The trust boundary from #2418 is preserved; this PR makes the native capability contract canonical:

- **Identity is handle-derived.** `SecureRoot` opens the root and derives `canonicalPath` from the opened handle (`F_GETPATH` / `/proc/self/fd` / `GetFinalPathNameByHandle`); the wrapper's pre-open `realpath` and the registry's vacuous swap check are gone. Mount-then-ask: the registry reads identity from the capability.
- **Revocation drains.** `close()` never blocks main; new operations fail closed immediately, in-flight reads drain against the pinned object. No lock is held across blocking I/O; Windows enumerations reopen the root handle-relatively for independent cursors.
- **Truncation is a partial result.** >10,000-entry directories render their first 10,000 entries plus an explicit `'truncated'` pseudo-node instead of failing.
- Registry review findings from #2418: session-root double-mount dedup, corrupt `rootsList` quarantine on mutation paths (restore stays fail-loud), dead injection seam removed, renderer last-folder write removed, native read-cap overflow fails loud.

Design: `docs/superpowers/specs/2026-08-12-bst-1237-canonical-capability-design.md`

## Ticket

BST-1237

Do not merge #2418 or #2410. This PR is the canonical replacement.

## Verification

(fill in the actual Task 9 gate results — lint/type-check/build/test task counts — before submitting)

## Windows note

The Windows identity derivation (`GetFinalPathNameByHandle`) and handle-relative reopen (`NtCreateFile`, empty name, `RootDirectory`) compile-verified only on CI platforms available to this repo; flagged for a Windows smoke before release.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Comment on #2418 (do NOT close it without the user)**

```bash
gh pr comment 2418 --body "Superseded by the canonical-capability redesign PR (see linked replacement). The native contract now derives identity from the opened handle, close() drains instead of blocking, and truncation is a visible partial result. Do not merge this PR."
```

- [ ] **Step 3: Watch checks**

```bash
gh pr checks --watch
```
Known CI traps: a `skipped` check can mask a failed required check on the same SHA; two runs on one SHA (one cancelled) reads as a failure; squash is the only working merge method on this repo.

---

## Self-Review (completed at plan time)

- **Spec coverage:** §1 identity → Task 1; §1 revocation/concurrency → Task 2; §1 bounds/read-cap → Tasks 5/6; §2 mount-then-ask + dedup → Task 3; §2 quarantine → Task 4; §2 deletions + React Doctor → Task 6; §3 truncation plumbing → Task 5; §4 error handling → embedded per task; §5 testing → per-task RED/GREEN + Tasks 7/9; §6 delivery → Tasks 0/10. Spec §3's parent-flag detail is amended to the pseudo-node approach in Task 5 Step 6.
- **Placeholder scan:** Task 3 Step 1's second test body is intentionally a skeleton with exact seeding instructions in prose below it; all other steps carry complete code. Two "find the existing helper" steps (Task 1 cleanup registration, Task 5 tree-test fixtures) point at concrete files rather than inventing helper names that may not match.
- **Type consistency:** `installMount(entry, secureRoot): string` (Task 3) is what Tasks 4-6 assume; `FileNodeType` gains exactly `'truncated'` (Tasks 5's registry + UI agree); `readStoredRootsOrQuarantine` is introduced in Task 4 and referenced nowhere earlier (Task 3 deliberately keeps `readStoredRoots`).
