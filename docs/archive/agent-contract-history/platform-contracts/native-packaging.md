# Native packaging evidence

Supports the desktop native packaging contract (BST-1920, PR #3462).

On 2026-10-02, a clean macOS arm64 package with `npmRebuild:false` passed
SQLite's packaged provenance smoke even after its unpacked node-pty binary was
removed. The real packaged terminal probe failed to load `pty.node` on that
same artifact. The smoke now runs a terminal and the existing secure-fs and
Parcel watcher probes in separate processes under the packaged executable.
SQLite's require-cache and mapped-file prebuild assertions remain isolated.

N-API compatibility is the vendor primitive, not an Electron rebuild exception:
[Node's ABI contract](https://nodejs.org/api/n-api.html#implications-of-abi-stability).
The installed node-pty 1.1.0 sources use `napi.h` on Unix and Windows and depend
on node-addon-api. Its npm package has Darwin and Windows prebuilds; Linux
builds the N-API addon at install. This does not authorize compiling either
SQLite dependency.

Linux arm64 uses the pinned python-build-standalone target and the same
no-dbm derivation as x64. Build preparation stages only the target archive plus
the manifest under `resources/python-runtime/linux/${arch}`; electron-builder
copies that directory and its matching full-distribution notice set. The
five-target matrix requires the same packaging and addon smokes for each target.

The correction was exercised on macOS arm64 and local Linux arm64 with Node
26.8.2 in the existing Docker runtime. Both built the desktop dependency closure
with no restored Turbo entries and packaged with native rebuilding disabled.
The combined packaged probe passed SQLite/prebuild provenance, sqlite-vec,
secure-fs, Parcel watcher and a real PTY shell on both targets. Linux additionally
passed packaged Python resource/helper layout and real offline Python execution,
resolver restart, factory reset and re-extraction. Missing vec0, missing PTY,
missing Python archive and a same-size corrupt archive each made the combined
Linux smoke fail; restoring the artifact returned it to green.

The previous exact PR head `3c6fdf66b82046ddca6951a719ee2cfece15292f` had four
successful hosted matrix legs in
[run 37010778374](https://github.com/seandearnaley/brainstrike/actions/runs/37010778374).
Those logs were inspected after hosted Actions were disabled. They do not
qualify this correction on Windows x64, Linux x64 or macOS Intel. No hosted run
was requested. macOS ad hoc hardened signing passed locally, but does not
establish Developer ID signing against a separately signed extension (BST-1936).
The Linux Python layout probe does not claim full OS-fence execution.
