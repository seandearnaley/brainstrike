; Python chunk-extraction query for tree-sitter-python.
;
; Matches every top-level (i.e., directly under `module`) definition that
; the chunker treats as a function-like unit:
;   - bare function definitions       def foo(): ...
;   - bare class definitions          class Foo: ...
;   - decorator-wrapped definitions   @decorator\ndef foo(): ...
;                                     @decorator\nclass Foo: ...
;
; `decorated_definition` wraps the function/class in its body, so matching
; *only* `function_definition` and `class_definition` at module level would
; miss decorated definitions entirely (their parent is `decorated_definition`,
; not `module`). Adding the `decorated_definition` pattern catches them; the
; bare patterns are kept for un-decorated cases.
;
; Why we don't recurse into nested definitions:
;   The chunker treats a function/class as a single chunk — nested
;   `def`/`class` inside a parent are part of that parent's chunk. Matching
;   only direct module children gives us this for free (tree-sitter query
;   patterns are structural; a nested function's path is
;   `module → function_definition → block → function_definition`, not
;   `module → function_definition`).
;
; Name extraction (BST-919, the "Phase N decision" this file predicted):
;   Each chunk pattern also captures the definition's identifier as @name.
;   The adapter emits ONE child per match (the @chunk node, annotated with
;   the @name text) — never the identifier itself, which would become a
;   phantom chunk boundary. Symbol REFERENCES (calls/imports) live in a
;   separate query below and ride the root's `symbolRefs` field.

(module (function_definition name: (identifier) @name) @chunk)
(module (class_definition name: (identifier) @name) @chunk)
(module (decorated_definition (function_definition name: (identifier) @name)) @chunk)
(module (decorated_definition (class_definition name: (identifier) @name)) @chunk)

; --- Symbol-reference query (compiled separately as SYMBOL_QUERIES) ---
; Calls and imports at any depth; names only. `aliased_import` is
; deliberately unmatched in v1 — a miss is an absent retrieval edge.
;
; (call function: (identifier) @call)
; (call function: (attribute attribute: (identifier) @call))
; (import_statement name: (dotted_name) @import_plain)
; (import_from_statement module_name: (dotted_name) @from_module name: (dotted_name) @from_name)
