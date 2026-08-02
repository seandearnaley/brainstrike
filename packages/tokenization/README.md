# @brainstrike/tokenization

Shared token estimation, cost calculation, and lazy o200k tokenization runtime.

Use the root or `token-counting-heuristics` entry for synchronous estimates and
cost helpers. Accurate counting is isolated behind the explicit
`token-counting-runtime`, `token-utils-accurate-lite`, and `token-utils-lite`
entrypoints so importing heuristics never loads tokenizer assets.
