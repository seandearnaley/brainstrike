# @brainstrike/chunking-worker

The portable canonical chunking algorithm (AST-aware splitting and token counting), executed by `@brainstrike/chunking-worker/node`.

- `createNodeChunker` requires an explicit OXC or Babel choice.
- Python always uses the shipped vendored tree-sitter grammar (`grammars/python.wasm`); there is no Python option.
- Runs in the utility process or CLI; Electron main is refused. No inference runtime, no catalog persistence.
- Failures:
  - Node parser/graph failures reject the file.
  - Missing Python grammar assets fail; the Node API never claims Python without its parser.
- Chunk indices, hashes, source offsets/lines, token/type/size metadata, symbols and references pass through unchanged. There is no second splitting algorithm.
- The `web-tree-sitter` pin is qualified for the Python grammar; see the note in [`package.json`](package.json) before bumping it.
