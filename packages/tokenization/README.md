# @brainstrike/tokenization

Shared token estimation, cost calculation, and lazy o200k tokenization runtime.

Use the root for synchronous estimates and cost helpers. Accurate counting is
isolated behind the two entrypoints that have real consumers:
`token-utils-accurate-lite` and `token-utils-lite`. Importing the root never
loads tokenizer assets.
