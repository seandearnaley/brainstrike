# Parser host Schema boundary

Supports `docs/agents/effect-boundary.md` § "Schema at boundaries".

## Decision (2026-09-25, BST-1827)

Validate parser requests and discriminated responses with `Schema.is` in a
main/utility-only module. The shared channel constants, interfaces and malformed
request ID extraction remain free of Effect. The IPC handler, utility entry and
main manager use the same schemas at the point of arrival.

This deliberately rejects array-shaped requests/options and incomplete success
or failure responses that the previous shallow checks accepted. A success needs
an object root; a failure needs an error string. Optional root type/start/end
fields must match the declared interface when present; explicitly `undefined`
optional fields remain valid. Extra fields and opaque AST descendants remain
untouched. `Schema.is` validates the original object, so it does not clone or
strip parser-specific children or recursively walk them.

Malformed input retains the existing curated response messages and correlation
ID recovery. The manager retains its bounded shape-only warning and ignores a
malformed reply, leaving a known pending request to its existing timeout. Schema
errors and source text are never placed into logs. No transport or protocol is
replaced, and no Effect code reaches a preload.

## Evidence

Eight regression cases failed with the old guards and passed with the new
boundary. The focused suite includes schema, IPC, parentPort, manager, real oxc
handler, host manifest and preload reachability: 65 tests passed. The full desktop
type-check, including strict Effect diagnostics, passed.

After rebasing onto merged provider auth (`21c260dee`), the same main build and
`gzip -9 -c` measured against that exact base:

| Bundle | Before raw | After raw | Raw delta | Before gzip | After gzip | Gzip delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| main.js | 2,699,875 | 2,701,117 | +1,242 | 575,246 | 575,430 | +184 |
| parser-host-entry.js | 20,101 | 21,057 | +956 | 6,392 | 6,577 | +185 |

Effect is external in these Node bundles: these are application bundle deltas,
not installed dependency size. The parser utility process now imports Effect;
the renderer and preload import graphs do not.

As a cold-start proxy, fresh Node 26 processes required each built parser utility
entry after the filesystem cache was warm, interleaving base and candidate five
times. The base samples were 13.54, 4.35, 3.69, 3.93 and 3.72 ms (median 3.93);
the candidate samples were 87.43, 78.85, 79.84, 77.88 and 83.26 ms (median
79.84). The first base sample was slower than the rest; an earlier first base
import took 189.72 ms before the filesystem cache was warm. This roughly 76 ms
warm-cache module-import cost is consistent with a separate bare `effect` import
(81–87 ms). It does not measure Electron process startup or
first parse latency, and could shift with runtime/module caching.

A synthetic response with 0, 1,000 and 10,000 opaque AST descendants took
roughly 0.00056, 0.00041 and 0.00037 ms per `Schema.is` check in 10,000-iteration
Node loops after warmup. This representative shape suggests the predicate does
not traverse opaque children; it is not a worst-case bound for arbitrary roots.

The compile-time parity guard was falsified by temporarily adding a schema-only
optional request field: desktop main type-check failed with TS2344, then passed
after restoring the source. AST root extra keys remain opaque by design, so the
index signature cannot enforce exact key parity for future optional root fields.
