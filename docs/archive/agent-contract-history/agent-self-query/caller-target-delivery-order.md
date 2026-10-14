# Caller lens target and SQL delivery order

Ship a lens's explicit target with SQL executable in that target's sandbox. The
golden must read the actual shipped artifact and exercise its declared engine.

The M2 reader extraction in PR3477 changed the caller artifact to target:index
before the independently committed SQLite caller port had landed. Its SQL still
contained the PGlite-only vector/BM25 operators and fields. Integration therefore
routed that artifact to an incompatible sandbox. A separate PGlite fixture
golden passed, and the bounded independent reader review missed this dependency.
Post-merge review identified the concrete error.

The composition candidate ed587 already contains the correct native caller port.
The smallest integration repair keeps the current PGlite body explicitly on app;
the next reviewed caller layer must change body and target together. This is
declared routing, with no runtime retry or automatic engine substitution.

The existing `search-lens-callers-hybrid.test.ts` now reads the shipped artifact,
checks target:app immediately before sandbox execution, and retains canonical
graph/ranking and hostile-bound-value assertions. Its prior fixture remains for
web qualification after the native artifact lands. All three existing cases
failed RED on the shipped target mismatch (`index` versus `app`), then passed
GREEN through the real PGlite sandbox after the one-line header correction.
Independent repair review also found the actual-artifact target inventory still
expected `index`; that existing contract failed RED (one failure among 57 cases).
The repair aligns its expectation with `app`; all 57 target/lens contract cases
and all three real PGlite cases then passed. The native port must change that
expectation with its body/header to `index`. Normal commit-hook results are
recorded with the delivery commits.
