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
; Why we don't extract names here:
;   Phase 3 ships chunk *ranges* (start/end), which is what
;   `collectTopLevelFunctionRanges` consumes. Names are useful for telemetry
;   and could be added by extending the query with `name: (identifier) @name`
;   captures — Phase N decision.

(module (function_definition) @chunk)
(module (class_definition) @chunk)
(module (decorated_definition) @chunk)
