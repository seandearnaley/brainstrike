# Why projection fitting binary-searches — evidence

Supports `docs/agents/agent-self-query.md` § "Projection fitting".
Read before changing `projectQuerySelfModelOutput` or its performance test. Extracted verbatim from the pre-distillation contract.

`querySelf` projections apply a 6,000-character domain budget. Rows are capped
at 200 by `maxRows`, but columns, lenses, and plan lines come from the database
or the user's lens directory and are not item-capped. Keep the largest complete
prefix by binary-searching the retained-item count. Dropping one item and
re-serializing the whole candidate on every iteration is quadratic—188 full
serializations on the maximum-row fixture alone, and unbounded for plan and
lens output. The paired performance test pins that fixture to a logarithmic
number of full-projection serializations while preserving the same
complete-prefix and explicit-omission contract.
