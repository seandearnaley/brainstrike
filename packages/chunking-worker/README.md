# Canonical chunking

The browser worker and `@brainstrike/chunking-worker/node` execute the same
portable algorithm. `createNodeChunker` requires an explicit OXC/Babel choice;
Python always uses the shipped vendored tree-sitter grammar, with no separate
Python configuration option. It runs in the utility/CLI owner; Electron main is
refused. It includes no inference runtime or catalog persistence.

Node parser/graph failures reject the file. Required Python grammar assets must
load successfully; the Node API cannot claim Python while omitting its parser.
Other languages retain their existing canonical strategy.
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

Exports/build scripts belong to [`package.json`](package.json).
[Shared contribution and validation policy](../../AGENTS.md) applies.
