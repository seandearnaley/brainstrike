# Renderer timeline and controlled idle reference

Supports the qualification rule in `../indexer.md`.

BST-1921's retained5b50 5000-file packet reports one216.7ms gap about10.2s into the loaded phase, frame p9917.7ms and zero long tasks. The gap is internal to the phase, so a boundary change cannot explain it. Raw gap arrays omitted renderer phase timestamps/time origin; exact correlation with acknowledged native progress was unavailable. Keep that failed packet unchanged.

The output adapter now retains endpoints for every existing selected interval, long-task start/duration, time origin and named windows, alongside identical gap and duration arrays. The runner clock origin aligns progress timestamps. RED: both adapter controls failed because timestamps were missing. GREEN must preserve the216.7ms fixture outlier and disjoint-phase/start-inside semantics; no product responsiveness repair is claimed.

The benchmark already takes150 idle chat samples on the same cold paused5000 corpus after warmup. Its assessment ignored idleChat entirely and accepted an absent/invalid reference. RED: a passing loaded sample accepted an empty idle baseline. Require100 finite nonnegative idle samples and record corpus/scope/profile/probe/window identity. Preserve54.93ms (historical1000 loaded49.93ms plus5ms), strict frames<50ms, zero long tasks, existing loaded sample/duration validity and all completion/cleanup assertions. This current idle reference does not reconstruct historical loaded BEFORE5000 or prove an architectural speedup.

One changed campaign is authorized after local preparation, independent review and a root-coordinated quiet measurement window. Results and remaining acceptance requirements belong in the retained external receipt. CI is disabled due to cost; validation must run locally.
