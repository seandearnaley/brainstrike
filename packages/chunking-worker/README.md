# Canonical chunking

The browser worker and `@brainstrike/chunking-worker/node` execute the same
portable algorithm. The Node entry requires an explicit OXC/Babel choice and
Python grammar configuration. It runs in the utility/CLI owner; Electron main
is refused. It includes no inference runtime or catalog persistence.

Node parser/graph failures reject the file. Missing Python capability rejects
Python AST requests. Other languages retain their existing canonical strategy.
Chunk indices, hashes, source offsets/lines, token/type/size metadata, symbols
and references are forwarded unchanged. No second splitting algorithm exists.

Browser output builds before the separate Node bundle, so parent/nested output
cleanup cannot race. The existing accurate tokenization owner selects its Node
runtime. Python uses the same shipped vendored grammar.

`pnpm test` exercises source behavior. `pnpm test:integration` starts plain Node
against the built public export and compares a recorded desktop result. Through
Turbo, integration testing depends explicitly on this package's build. This
proof does not qualify utility runtime wiring, actual source discovery/watch,
visible-window closure, inference, packaging or other platforms.

CI is disabled due to cost; validation must run locally.
