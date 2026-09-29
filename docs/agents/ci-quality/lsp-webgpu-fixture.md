# WebGPU LSP compatibility fixture

Supports `docs/agents/ci-quality.md` § "TypeScript 7 CLI with the TypeScript 6 compatibility API".

## BST-1829, 2026-09-25

The post-merge desktop [Unit shard](https://github.com/seandearnaley/brainstrike/actions/runs/36167837442/job/108179863310) timed out twice while
checking the real `device-detection.ts` through the bundled TypeScript 6 LSP.
Each edit had the unchanged 6-second production diagnostics budget; the test
assumed one timed-out warm-up made a second identical edit fast enough. Other
real LSP subprocess cases in that shard passed, and the same WebGPU case passed
locally in 2.7 seconds. This is consistent with load-sensitive analysis of the
repository project; the CI log does not establish why the server did not
publish within either deadline. A local falsification also showed that an
identical second edit can time out even in the isolated fixture: the diagnostics
manager clears the previous publish before `didChange`, while the server need
not publish again for unchanged content. A timeout retry with identical content
is therefore not reliable.

The compatibility test now copies the exact production source to a temporary
one-file project under `packages/embeddings`, where its normal workspace
imports resolve. Its `tsconfig.json` extends that package's real configuration,
overriding only the file set and output locations; it does not inherit the
package's nine project references. It asks the real bundled TypeScript 6
language server for a clean result on the first edit, then checks that a
conflicting `GPUAdapter.isFallbackAdapter` declaration produces a diagnostic
and that restoring the source returns to clean. The temporary project is
removed in `finally`; production diagnostics timeout and server code are
unchanged.

The first clean edit and restored edit returned no diagnostics. The conflicting
edit returned one TypeScript error: `isFallbackAdapter` must be
`boolean | undefined`, but the injected declaration made it
`string | undefined`. The public edit-diagnostic shape has no numeric code.
The focused case passed in 3.1 seconds, and all 16 real-subprocess LSP tests
passed in 17.8 seconds on the implementation branch. This fixture checks the
TS6 WebGPU surface; the regular TypeScript 7 type-check remains the production
compiler gate.
