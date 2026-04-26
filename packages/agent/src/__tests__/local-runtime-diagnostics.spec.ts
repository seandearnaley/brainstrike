/**
 * Regression tests for the "probe silently misses a running Ollama" bug report.
 *
 * The user reported: launched the desktop app with Ollama running locally,
 * opened Settings → Local Runtimes, and the Ollama card showed as not
 * available even though a real server was listening on 127.0.0.1:11434.
 *
 * Root-cause hypotheses the red tests pin down:
 *   1. The discovery service swallows fetch errors without logging, so the
 *      user can't tell WHY the probe failed (CORS, DNS, firewall, timeout).
 *   2. A CORS rejection in the renderer surfaces as a generic `TypeError:
 *      Failed to fetch`, which the existing heuristic only classifies as
 *      `blocked_web` on the web surface — on desktop it just becomes
 *      `unavailable` with an opaque message.
 *
 * These tests intentionally exercise the CURRENT behaviour first. Tests that
 * depend on the fix land in a follow-up commit so the red → green transition
 * is visible in git history.
 */

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  LocalRuntimeDiscoveryService,
  type LocalRuntimeLogger,
} from '../providers/local-runtime-discovery';
import { LocalRuntimeModelCatalogService } from '../providers/local-runtime-model-catalog';

type FetchMock = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type LogFn = Mock<(message: string, meta?: unknown) => void>;
interface LoggerMock extends LocalRuntimeLogger {
  debug: LogFn;
  error: LogFn;
  info: LogFn;
  warn: LogFn;
}

function createLoggerMock(): LoggerMock {
  return {
    debug: vi.fn<(message: string, meta?: unknown) => void>(),
    error: vi.fn<(message: string, meta?: unknown) => void>(),
    info: vi.fn<(message: string, meta?: unknown) => void>(),
    warn: vi.fn<(message: string, meta?: unknown) => void>(),
  };
}

// Simulate Chromium's CORS rejection signature. When an Electron renderer
// fetches `http://127.0.0.1:11434/api/tags` and the Ollama server does not
// return an `Access-Control-Allow-Origin` header matching the renderer's
// origin (`file://`, `app://`, or a dev Vite URL), the browser throws a
// `TypeError: Failed to fetch` BEFORE the response ever reaches JS.
function simulateCorsRejection(): never {
  throw new TypeError('Failed to fetch');
}

describe('local-runtime diagnostics (desktop probe visibility)', () => {
  let loggerMock: LoggerMock;

  beforeEach(() => {
    loggerMock = createLoggerMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('logs probe failures with the runtime id, endpoint, and error message', async () => {
    const fetchMock = vi.fn<FetchMock>(() => Promise.reject(simulateCorsRejection()));

    const service = new LocalRuntimeDiscoveryService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 1000,
      logger: loggerMock,
    });

    const status = await service.probeRuntime('ollama', { surface: 'desktop' });

    expect(status.state).toBe('unavailable');
    // The user reported being unable to tell WHY the probe failed. At minimum
    // the service must emit a warn-level record that includes enough detail
    // to distinguish "Ollama not running" from "Ollama running but refusing
    // our origin" from "DNS pointed at ::1 instead of 127.0.0.1".
    expect(loggerMock.warn).toHaveBeenCalled();
    const [, meta] = loggerMock.warn.mock.calls[0] ?? [];
    expect(meta).toMatchObject({
      runtime: 'ollama',
      endpoint: expect.stringContaining('11434'),
      state: 'unavailable',
      message: expect.stringContaining('Failed to fetch'),
    });
  });

  it('dedupes concurrent probe failures and logs one warning for the shared result', async () => {
    const fetchMock = vi.fn<FetchMock>(() => Promise.reject(simulateCorsRejection()));

    const service = new LocalRuntimeDiscoveryService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 1100,
      logger: loggerMock,
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => service.probeRuntime('ollama', { surface: 'desktop' }))
    );

    expect(results.every((result) => result.state === 'unavailable')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      loggerMock.warn.mock.calls.filter(
        ([message]) => message === 'local runtime probe did not reach available state'
      )
    ).toHaveLength(1);
  });

  it('demotes repeated probe failures after the first warning', async () => {
    let nowMs = 1200;
    const fetchMock = vi.fn<FetchMock>(() => Promise.reject(simulateCorsRejection()));

    const service = new LocalRuntimeDiscoveryService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      failureBaseBackoffMs: 100,
      now: () => nowMs,
      logger: loggerMock,
    });

    await service.probeRuntime('ollama', { surface: 'desktop' });
    nowMs = 1400;
    await service.probeRuntime('ollama', { surface: 'desktop' });

    expect(
      loggerMock.warn.mock.calls.filter(
        ([message]) => message === 'local runtime probe did not reach available state'
      )
    ).toHaveLength(1);
    expect(
      loggerMock.debug.mock.calls.filter(
        ([message]) => message === 'local runtime probe did not reach available state'
      )
    ).toHaveLength(1);
  });

  it('logs model catalog failures when every endpoint returns a non-OK status', async () => {
    const fetchMock = vi.fn<FetchMock>(async () => new Response('no', { status: 503 }));

    const service = new LocalRuntimeModelCatalogService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 2000,
      logger: loggerMock,
    });

    const result = await service.listRuntimeModels('ollama', {
      surface: 'desktop',
      force: true,
    });

    // The probe itself succeeds (because the /api/version probe returns 503
    // and we fall through to the listing stage which reports failed), but we
    // still want the catalog failure to be visible in logs so "Settings →
    // Local Runtimes shows Unavailable" becomes investigable.
    expect(result.state).toMatch(/failed|stale_cached/);
    expect(loggerMock.warn).toHaveBeenCalled();
  });

  it('dedupes concurrent model catalog failures and logs one catalog warning', async () => {
    const fetchMock = vi.fn<FetchMock>(() => Promise.reject(simulateCorsRejection()));

    const service = new LocalRuntimeModelCatalogService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 2100,
      logger: loggerMock,
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.listRuntimeModels('lmstudio', {
          surface: 'desktop',
          force: true,
        })
      )
    );

    expect(results.every((result) => result.state === 'failed')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      loggerMock.warn.mock.calls.filter(
        ([message]) => message === 'local runtime model catalog failed'
      )
    ).toHaveLength(1);
  });

  it('classifies TypeError from a desktop fetch with enough detail for the user to diagnose CORS', async () => {
    // The existing code maps TypeError to `unavailable` on desktop with
    // `message: "Failed to fetch"`. That message gives the user no hint that
    // Ollama's CORS policy may be rejecting the renderer's origin. This
    // regression test asserts we surface a CORS-hint when the error message
    // matches that signature so the settings UI can surface it.
    const fetchMock = vi.fn<FetchMock>(() => Promise.reject(simulateCorsRejection()));

    const service = new LocalRuntimeDiscoveryService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 3000,
      logger: loggerMock,
    });

    const status = await service.probeRuntime('ollama', { surface: 'desktop' });

    if (status.state !== 'unavailable') {
      throw new Error(`Expected unavailable, got ${status.state}`);
    }
    // New shape: the failure carries a `hint` the UI can render to explain
    // why the probe failed in Electron-renderer context specifically.
    expect(status).toMatchObject({
      state: 'unavailable',
      hint: expect.stringMatching(/CORS|cross-origin|main process|OLLAMA_ORIGINS/i),
    });
  });

  it('hint does not assert CORS as the cause when the server may simply not be running', async () => {
    // Reviewer feedback: Chromium throws the same `TypeError: Failed to fetch`
    // for DNS resolution, connection refused, AND CORS rejections. A hint
    // that tells the user to "set OLLAMA_ORIGINS" when the real problem is
    // "Ollama isn't running" sends them down the wrong debugging path.
    //
    // Contract: the hint must acknowledge BOTH possibilities (not-running
    // and origin/CORS) so the user can triage from the text alone.
    const fetchMock = vi.fn<FetchMock>(() => Promise.reject(simulateCorsRejection()));

    const service = new LocalRuntimeDiscoveryService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 3100,
      logger: loggerMock,
    });

    const status = await service.probeRuntime('ollama', { surface: 'desktop' });

    if (status.state !== 'unavailable') {
      throw new Error(`Expected unavailable, got ${status.state}`);
    }
    // Must cover "server may not be running" — the most common cause — in
    // addition to OLLAMA_ORIGINS / main-process-probe guidance.
    expect(status.hint).toMatch(/not (be )?running|unreachable|start Ollama/i);
  });

  it('tailors the desktop CORS hint to the runtime being probed', async () => {
    // Reviewer feedback (#71): a single shared hint that mentions both
    // "Ollama or LM Studio" and only `OLLAMA_ORIGINS` is confusing when
    // the user is probing LM Studio — they get advice for the wrong
    // product. We tailor the hint per-runtime so each probe surfaces
    // guidance for the daemon the user is actually configuring.
    const fetchMock = vi.fn<FetchMock>(() => Promise.reject(simulateCorsRejection()));

    const service = new LocalRuntimeDiscoveryService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 3200,
      logger: loggerMock,
    });

    const ollamaStatus = await service.probeRuntime('ollama', { surface: 'desktop' });
    if (ollamaStatus.state !== 'unavailable') {
      throw new Error(`Expected unavailable, got ${ollamaStatus.state}`);
    }
    expect(ollamaStatus.hint).toMatch(/Ollama/);
    expect(ollamaStatus.hint).toMatch(/OLLAMA_ORIGINS/);
    expect(ollamaStatus.hint).not.toMatch(/LM Studio/);

    const lmStudioStatus = await service.probeRuntime('lmstudio', { surface: 'desktop' });
    if (lmStudioStatus.state !== 'unavailable') {
      throw new Error(`Expected unavailable, got ${lmStudioStatus.state}`);
    }
    expect(lmStudioStatus.hint).toMatch(/LM Studio/);
    // The Ollama-specific env-var name should not appear in an LM Studio hint.
    expect(lmStudioStatus.hint).not.toMatch(/OLLAMA_ORIGINS/);
  });

  it('exposes getCachedState even after a silent renderer-side probe failure', async () => {
    // User could also debug by inspecting the cached state. This test pins the
    // contract that a failed probe leaves a visible cached entry with a
    // message, not an undefined/null one.
    const fetchMock = vi.fn<FetchMock>(() => Promise.reject(simulateCorsRejection()));

    const service = new LocalRuntimeDiscoveryService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 4000,
    });

    await service.probeRuntime('ollama', { surface: 'desktop' });
    const cached = service.getCachedState('ollama');

    expect(cached).not.toBeNull();
    expect(cached?.state).toBe('unavailable');
    if (cached?.state === 'unavailable') {
      expect(cached.message).toBeTruthy();
    }
  });
});
