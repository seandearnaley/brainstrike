# Model download ownership

Supports `local-inference.md` § "Hidden host execution boundary".

BST-1910: the public backend download method previously awaited
`pipeline('feature-extraction', ...)` and discarded its result. `_pipeline` never
owned that temporary pipeline, so backend disposal did not release its session.
Desktop settings invoked this path in the visible renderer.

The corrected desktop path uses the existing hidden-host request channel,
foreground FIFO generation and indexing-drain gate. Downloads are explicit
operations on `StreamingEmbeddingWorkerClient`, with an owned worker and the
platform's registered worker asset URL; they perform no dummy inference and add
no polling loop. Stop/reset closes admission and aborts the exact generation.
Web settings owns and disposes its temporary service too.

The installed Transformers.js 4.3.0 public `pipeline` options expose
`progress_callback` and `cache_dir`; `Pipeline.dispose()` awaits model disposal
and underlying session release. Source: installed `types/transformers.d.ts`,
`types/utils/hub.d.ts`, `src/pipelines/_base.js`; official API:
https://huggingface.co/docs/transformers.js/api/pipelines.
The temporary pipeline is disposed exactly once before download completion.
Worker termination owns cleanup when a download is interrupted before the
public factory returns; creation/disposal errors reject rather than report
completion. Per-file progress is capped at 99 because file completion does not
prove session creation and release have succeeded.

Controlled tests exercise the actual backend, service, mounted hidden runtime,
manager, streaming client and worker dispatch with a public pipeline factory.
They assert disposal ordering, progress spelling, repeated FIFO requests,
creation/disposal errors, exact cancellation identity and owned termination
before Stop/reset acknowledgement. The original backend failed all three new
ownership tests before implementation. This evidence proves ownership and
ordering; it measures neither GPU VRAM nor a wall-clock performance improvement.
No real model download or hardware benchmark is part of these tests.

The source-only public API probe against baseline
`2587428198671a60768cb051b374fe15b09c7cee` calls backend `downloadModel` and
`dispose`; it fails the release assertion with one pipeline creation and zero
disposals. The corrected factory and worker tests require awaited release or
owned termination before settlement.

`model-download-owner.browser.test.ts` also exercises the actual backend/client
in headless Chromium with real module Workers and a tiny public factory fixture.
An independent BroadcastChannel heartbeat stops after factory failure, session
release failure, and an uncaught worker runtime error. The observation allows
100 ms for queued messages, then checks 150 ms without new heartbeats. This
proves physical Worker termination in those paths; it measures no model memory,
VRAM, or large-download performance.

Qualification: normal desktop dependency build (49 tasks), complete desktop type
check (632 test files and 638 Effect diagnostic files; zero diagnostics), 138
main/preload regression tests, 98 worker unit tests, five backend ownership tests,
and three real-Worker browser tests passed. Exact main IPC manifest expectations
include both download channels; preload isolation expectations remain enforced.
